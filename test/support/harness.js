'use strict';

const express = require('express');
const supertest = require('supertest');
const { InMemoryQueue } = require('../../src/broker/queue');
const { createErpApp } = require('../../src/erp/app');
const { BillingWorker } = require('../../src/worker/billing-worker');
const { ErpClient } = require('../../src/worker/erp-client');
const { IdempotencyStore } = require('../../src/worker/idempotency-store');
const { buildRequest, sleep } = require('./builders');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Requester side: receives the callbacks and can simulate being down. */
function createCallbackReceiver() {
  const receiver = { received: [], rejected: 0, failNext: 0 };
  const app = express();
  app.use(express.json());
  app.post('/callbacks', (req, res) => {
    if (receiver.failNext > 0) {
      receiver.failNext -= 1;
      receiver.rejected += 1;
      return res.status(503).end();
    }
    receiver.received.push(req.body);
    return res.status(204).end();
  });
  return { app, receiver };
}

/**
 * Wires a full test environment: fake ERP, callback receiver, queue, idempotency store and workers.
 * Everything runs in-process on random local ports, so each test starts from a clean state.
 */
async function createHarness({
  queueOptions = {},
  safeguards = {},
  hooks = {},
  workerCount = 1,
  erpTimeoutMs = 1000,
  erpLatencyMs = 0,
} = {}) {
  const erpServer = await listen(createErpApp({ latencyMs: erpLatencyMs }));
  const erpUrl = `http://127.0.0.1:${erpServer.address().port}`;

  const { app: callbackApp, receiver } = createCallbackReceiver();
  const callbackServer = await listen(callbackApp);
  const callbackUrl = `http://127.0.0.1:${callbackServer.address().port}/callbacks`;

  const queue = new InMemoryQueue({ lockDurationMs: 1000, maxDeliveryCount: 3, ...queueOptions });
  const store = new IdempotencyStore();
  const erpClient = new ErpClient({ baseUrl: erpUrl, timeoutMs: erpTimeoutMs });
  const workers = Array.from(
    { length: workerCount },
    (_, i) =>
      new BillingWorker({
        id: `worker-${i + 1}`,
        queue,
        erp: erpClient,
        store,
        safeguards,
        hooks,
        callbackOptions: { timeoutMs: 1000, retries: 2 },
      }),
  );
  const erp = supertest(erpUrl);

  return {
    queue,
    store,
    workers,
    worker: workers[0],
    receiver,
    callbacks: receiver.received,
    callbackUrl,
    erp,

    request(overrides = {}) {
      return buildRequest({ callbackUrl, ...overrides });
    },

    /** Publishes like the source system does: messageId = idempotencyKey, sessionId = customerId. */
    publish(request, { messageId = request.idempotencyKey, sessionId = request.customerId } = {}) {
      return queue.send({ messageId, sessionId, body: request });
    },

    /** Runs all workers concurrently until the queue is empty. Returns every non-empty outcome. */
    async drain({ timeoutMs = 5000, pollMs = 10 } = {}) {
      const outcomes = [];
      const deadline = Date.now() + timeoutMs;
      await Promise.all(
        workers.map(async (w) => {
          while (queue.activeCount > 0 && Date.now() < deadline) {
            const result = await w.processOne();
            if (result.outcome === 'EMPTY') await sleep(pollMs);
            else outcomes.push({ worker: w.id, ...result });
          }
        }),
      );
      if (queue.activeCount > 0) throw new Error(`Queue was not drained within ${timeoutMs} ms`);
      return outcomes;
    },

    async documents(reference) {
      const res = await erp.get('/documents').query({ reference }).expect(200);
      return res.body;
    },

    async stats() {
      return (await erp.get('/__test/stats').expect(200)).body;
    },

    async fault(definition) {
      await erp.post('/__test/faults').send(definition).expect(201);
    },

    async close() {
      for (const server of [erpServer, callbackServer]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}

module.exports = { createHarness };
