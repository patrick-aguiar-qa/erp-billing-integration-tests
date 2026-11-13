'use strict';

const { expect } = require('chai');
const { createHarness } = require('./support/harness');
const { crashOnce, sleep, timeWindow, overlaps } = require('./support/builders');

// Risk R1 (highest): the same request produces a second fiscal document.
// Each test reproduces one concrete way a duplicate can happen in a message-driven integration.
describe('Duplicate protection (exactly one fiscal document per idempotency key)', () => {
  let h;
  afterEach(() => h?.close());

  async function expectSingleBilling(key, { deliveries = 1 } = {}) {
    const docs = await h.documents(key);
    expect(docs.salesOrders, 'sales orders').to.have.length(1);
    expect(docs.deliveries, 'deliveries').to.have.length(deliveries);
    expect(docs.invoices, 'invoices').to.have.length(1);
    return docs;
  }

  describe('Resent requests', () => {
    it('the broker rejects the same messageId inside the duplicate-detection window', async () => {
      h = await createHarness();
      const req = h.request();
      expect(h.publish(req)).to.deep.equal({ accepted: true });
      expect(h.publish(req)).to.deep.equal({ accepted: false, reason: 'DUPLICATE_MESSAGE_ID' });

      await h.drain();
      await expectSingleBilling(req.idempotencyKey);
      expect(h.callbacks).to.have.length(1);
    });

    it('a request resent after the window only gets the stored result again, without ERP calls', async () => {
      h = await createHarness({ queueOptions: { duplicateWindowMs: 30 } });
      const req = h.request();
      h.publish(req);
      await h.drain();
      const callsAfterFirst = (await h.stats()).requests;

      await sleep(40);
      expect(h.publish(req).accepted, 'broker window expired').to.equal(true);
      const [outcome] = await h.drain();

      expect(outcome.outcome).to.equal('DUPLICATE_RESENT');
      expect((await h.stats()).requests).to.deep.equal(callsAfterFirst);
      await expectSingleBilling(req.idempotencyKey);
      expect(h.callbacks).to.have.length(2);
      expect(h.callbacks[1]).to.deep.equal(h.callbacks[0]);
    });

    it('a request resent after a BUSINESS_ERROR gets the same answer and is not sent to the ERP again', async () => {
      h = await createHarness({ queueOptions: { duplicateWindowMs: 30 } });
      const req = h.request({ customerId: 'C-2001' });
      h.publish(req);
      await h.drain();

      await sleep(40);
      h.publish(req);
      const [outcome] = await h.drain();

      expect(outcome).to.include({ outcome: 'DUPLICATE_RESENT', status: 'BUSINESS_ERROR' });
      expect((await h.stats()).requests['POST /sales-orders']).to.equal(1);
      expect(h.callbacks.map((c) => c.code)).to.deep.equal(['CUSTOMER_BLOCKED', 'CUSTOMER_BLOCKED']);
    });
  });

  describe('Worker crashes (process dies, lock expires, broker redelivers)', () => {
    const crashPoints = [
      ['the sales order', 'salesOrder'],
      ['the delivery', 'delivery'],
      ['the invoice', 'invoice'],
    ];

    for (const [label, step] of crashPoints) {
      it(`crash right after the ERP committed ${label}: the retry reconciles instead of recreating it`, async () => {
        h = await createHarness({
          queueOptions: { lockDurationMs: 150 },
          hooks: { afterErpCommit: crashOnce((ctx) => ctx.step === step) },
        });
        const req = h.request();
        h.publish(req);

        const outcomes = await h.drain();
        expect(outcomes.map((o) => o.outcome)).to.deep.equal(['CRASHED', 'SUCCESS']);
        expect(outcomes[1].deliveryCount).to.equal(2);

        const docs = await expectSingleBilling(req.idempotencyKey);
        expect(h.callbacks).to.have.length(1);
        expect(h.callbacks[0].documents).to.include({
          salesOrderId: docs.salesOrders[0].salesOrderId,
          fiscalNumber: docs.invoices[0].fiscalNumber,
        });
      });
    }

    it('crash after the callback but before completing the message: the retry resends the same result', async () => {
      h = await createHarness({
        queueOptions: { lockDurationMs: 150 },
        hooks: { afterCallback: crashOnce(() => true) },
      });
      const req = h.request();
      h.publish(req);

      const outcomes = await h.drain();
      expect(outcomes.map((o) => o.outcome)).to.deep.equal(['CRASHED', 'DUPLICATE_RESENT']);
      await expectSingleBilling(req.idempotencyKey);
      expect(h.callbacks).to.have.length(2);
      expect(h.callbacks[1], 'callbacks are at-least-once and identical').to.deep.equal(h.callbacks[0]);
    });
  });

  describe('ERP timeouts after commit (the worker gave up, the ERP did not)', () => {
    for (const route of ['POST /sales-orders', 'POST /invoices']) {
      it(`${route} times out after committing: the retry finds the document instead of creating another`, async () => {
        h = await createHarness({ erpTimeoutMs: 150 });
        await h.fault({ route, mode: 'timeout-after-commit', delayMs: 400 });
        const req = h.request();
        h.publish(req);

        const outcomes = await h.drain();
        expect(outcomes.map((o) => o.outcome)).to.deep.equal(['RETRY', 'SUCCESS']);
        expect(outcomes[0].code).to.equal('ERP_TIMEOUT');
        await expectSingleBilling(req.idempotencyKey);
      });
    }
  });

  describe('Concurrency between workers', () => {
    it('two requests for the same customer never run at the same time (broker sessions)', async () => {
      h = await createHarness({ workerCount: 2, erpLatencyMs: 30 });
      const first = h.request({ customerId: 'C-1001' });
      const second = h.request({ customerId: 'C-1001' });
      h.publish(first);
      h.publish(second);

      const outcomes = await h.drain();
      expect(outcomes.map((o) => o.outcome)).to.deep.equal(['SUCCESS', 'SUCCESS']);

      const a = timeWindow(await h.documents(first.idempotencyKey));
      const b = timeWindow(await h.documents(second.idempotencyKey));
      expect(overlaps(a, b), `windows ${JSON.stringify(a)} and ${JSON.stringify(b)}`).to.equal(false);
      expect(b.start, 'FIFO inside the session').to.be.greaterThan(a.end);
    });

    it('a slow ERP call longer than the lock keeps the message owned (lock renewal): no second worker picks it', async () => {
      h = await createHarness({ workerCount: 2, queueOptions: { lockDurationMs: 300 }, erpTimeoutMs: 3000 });
      await h.fault({ route: 'POST /sales-orders', mode: 'slow', delayMs: 1000 });
      const req = h.request();
      h.publish(req);

      const outcomes = await h.drain();
      expect(outcomes).to.have.length(1);
      expect(outcomes[0]).to.include({ outcome: 'SUCCESS', deliveryCount: 1 });
      await expectSingleBilling(req.idempotencyKey);
    });
  });

  describe('Resubmission after a technical failure', () => {
    it('a request dead-lettered halfway is resumed from where it stopped when resubmitted', async () => {
      h = await createHarness({ queueOptions: { duplicateWindowMs: 30 } });
      await h.fault({ route: 'POST /invoices', mode: 'error', status: 503, times: 3 });
      const req = h.request();
      h.publish(req);

      const firstRun = await h.drain();
      expect(firstRun.map((o) => o.outcome)).to.deep.equal(['RETRY', 'RETRY', 'DEAD_LETTERED']);
      expect(h.store.get(req.idempotencyKey).status).to.equal('FAILED');
      const partial = await h.documents(req.idempotencyKey);
      expect(partial.salesOrders).to.have.length(1);
      expect(partial.invoices).to.have.length(0);

      await sleep(40);
      h.publish(req);
      const [retry] = await h.drain();
      expect(retry.outcome).to.equal('SUCCESS');

      const docs = await expectSingleBilling(req.idempotencyKey);
      expect(docs.salesOrders[0].salesOrderId).to.equal(partial.salesOrders[0].salesOrderId);
    });
  });
});
