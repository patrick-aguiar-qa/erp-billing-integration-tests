'use strict';

const { LockLostError } = require('../broker/queue');
const { validateRequest } = require('../contracts/validator');
const { postCallback } = require('./callback-client');
const { BusinessError, TechnicalError, SimulatedCrash } = require('./errors');
const { OPERATIONS, STEPS } = require('./operations');

/**
 * The safeguards against duplicate documents. All on by default; the negative-control
 * tests switch them off one at a time to prove each one is needed.
 */
const DEFAULT_SAFEGUARDS = {
  idempotency: true, // record every key before touching the ERP and never reprocess a COMPLETED key
  reconcile: true, // after a failed attempt, look the documents up in the ERP before creating anything
  renewLock: true, // keep the message lock alive during long ERP calls
};

const asString = (value) => (typeof value === 'string' ? value : null);

function buildResult(request, status, { code, messages, documents, attempt }) {
  return {
    requestId: request.requestId,
    idempotencyKey: asString(request.idempotencyKey),
    operation: asString(request.operation),
    status,
    code,
    messages,
    ...(documents ? { documents } : {}),
    attempt,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Consumes billing requests from the queue, runs the ERP steps of the requested operation
 * and sends a standardized result to the requester's callback URL.
 */
class BillingWorker {
  constructor({ id = 'worker-1', queue, erp, store, safeguards = {}, hooks = {}, callbackOptions = {} }) {
    Object.assign(this, { id, queue, erp, store, hooks, callbackOptions });
    this.safeguards = { ...DEFAULT_SAFEGUARDS, ...safeguards };
  }

  /** Receives and processes at most one message. */
  async processOne() {
    const message = this.queue.receive();
    if (!message) return { outcome: 'EMPTY' };

    const lock = this.#keepLockAlive(message);
    const summary = (outcome) => ({ messageId: message.messageId, deliveryCount: message.deliveryCount, ...outcome });
    try {
      return summary(await this.#handle(message, lock));
    } catch (err) {
      if (err instanceof SimulatedCrash) return summary({ outcome: 'CRASHED' });
      if (err instanceof LockLostError) return summary({ outcome: 'LOCK_LOST' });
      throw err;
    } finally {
      lock.stop();
    }
  }

  async #handle(message, lock) {
    const request = message.body;

    const { valid, errors } = validateRequest(request);
    if (valid) {
      if (request.idempotencyKey !== message.messageId) errors.push('idempotencyKey must be equal to the broker messageId');
      if (request.customerId !== message.sessionId) errors.push('customerId must be equal to the broker sessionId');
    }
    if (errors.length) return this.#rejectEnvelope(message, request, errors);

    const key = request.idempotencyKey;
    const { idempotency, reconcile } = this.safeguards;
    const record = idempotency ? this.store.get(key) : undefined;

    if (record?.status === 'COMPLETED') {
      // Already processed: never touch the ERP again, only resend the stored result.
      return this.#deliverAndSettle(message, record.result, 'DUPLICATE_RESENT');
    }

    // IN_PROGRESS or FAILED means an earlier attempt may already have written to the ERP.
    const recovering = record !== undefined;
    if (idempotency) this.store.start(key, request.requestId);

    let documents = { ...(record?.documents ?? {}) };
    let result;
    try {
      if (recovering && reconcile) documents = await this.#reconcile(key, documents);

      for (const stepName of OPERATIONS[request.operation]) {
        const step = STEPS[stepName];
        if (step.isDone(documents)) continue;
        this.#assertLock(lock);
        Object.assign(documents, await step.run(this.erp, request, documents));
        await this.hooks.afterErpCommit?.({ step: stepName, documents, message, worker: this.id });
        if (idempotency) this.store.checkpoint(key, documents);
      }

      result = buildResult(request, 'SUCCESS', {
        code: 'OK',
        messages: ['Billing completed'],
        documents,
        attempt: message.deliveryCount,
      });
    } catch (err) {
      if (err instanceof BusinessError) {
        result = buildResult(request, 'BUSINESS_ERROR', {
          code: err.code,
          messages: [err.message],
          attempt: message.deliveryCount,
        });
      } else if (err instanceof TechnicalError) {
        return this.#technicalFailure(message, request, err);
      } else {
        throw err;
      }
    }

    if (idempotency) this.store.complete(key, result);
    return this.#deliverAndSettle(message, result, result.status);
  }

  /** Finds documents a previous attempt created but did not checkpoint (crash, timeout after commit). */
  async #reconcile(key, documents) {
    const found = await this.erp.findDocuments(key);
    const order = found.salesOrders[0];
    if (!order) return documents;

    const delivery = found.deliveries.find((d) => d.salesOrderId === order.salesOrderId);
    const invoice = found.invoices.find((i) => i.salesOrderId === order.salesOrderId);
    return {
      ...documents,
      salesOrderId: order.salesOrderId,
      ...(delivery ? { deliveryId: delivery.deliveryId } : {}),
      ...(invoice ? { invoiceId: invoice.invoiceId, fiscalNumber: invoice.fiscalNumber } : {}),
    };
  }

  async #technicalFailure(message, request, err) {
    if (message.deliveryCount < this.queue.maxDeliveryCount) {
      this.queue.abandon(message.lockToken); // the broker redelivers it
      return { outcome: 'RETRY', code: err.code };
    }

    const result = buildResult(request, 'TECHNICAL_ERROR', {
      code: err.code,
      messages: [err.message],
      attempt: message.deliveryCount,
    });
    if (this.safeguards.idempotency) this.store.fail(request.idempotencyKey, result);
    await postCallback(request.callbackUrl, result, this.callbackOptions).catch(() => {});
    this.queue.deadLetter(message.lockToken, err.code);
    return { outcome: 'DEAD_LETTERED', status: 'TECHNICAL_ERROR', code: err.code };
  }

  async #deliverAndSettle(message, result, outcome) {
    try {
      await postCallback(message.body.callbackUrl, result, this.callbackOptions);
    } catch (err) {
      if (!(err instanceof TechnicalError)) throw err;
      // The result is already stored, so a redelivery only resends the callback.
      if (message.deliveryCount >= this.queue.maxDeliveryCount) {
        this.queue.deadLetter(message.lockToken, err.code);
        return { outcome: 'DEAD_LETTERED', status: result.status, code: err.code };
      }
      this.queue.abandon(message.lockToken);
      return { outcome: 'CALLBACK_RETRY', status: result.status, code: err.code };
    }

    await this.hooks.afterCallback?.({ message, result, worker: this.id });
    this.queue.complete(message.lockToken);
    return { outcome, status: result.status, code: result.code };
  }

  async #rejectEnvelope(message, request, errors) {
    const canReply =
      typeof request?.requestId === 'string' &&
      request.requestId.length > 0 &&
      typeof request.callbackUrl === 'string' &&
      /^https?:\/\/\S+$/.test(request.callbackUrl);

    if (canReply) {
      const result = buildResult(request, 'BUSINESS_ERROR', {
        code: 'INVALID_ENVELOPE',
        messages: errors,
        attempt: message.deliveryCount,
      });
      await postCallback(request.callbackUrl, result, this.callbackOptions).catch(() => {});
    }
    this.queue.deadLetter(message.lockToken, 'INVALID_ENVELOPE');
    return { outcome: 'INVALID_ENVELOPE', errors, callbackSent: canReply };
  }

  #keepLockAlive(message) {
    const state = { lost: false, timer: null };
    if (this.safeguards.renewLock) {
      state.timer = setInterval(() => {
        try {
          this.queue.renewLock(message.lockToken);
        } catch {
          state.lost = true;
          clearInterval(state.timer);
        }
      }, Math.max(10, Math.floor(this.queue.lockDurationMs / 3)));
    }
    return {
      get lost() {
        return state.lost;
      },
      stop: () => clearInterval(state.timer),
    };
  }

  #assertLock(lock) {
    if (lock.lost) throw new LockLostError();
  }
}

module.exports = { BillingWorker, DEFAULT_SAFEGUARDS };
