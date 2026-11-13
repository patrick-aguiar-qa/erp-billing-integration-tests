'use strict';

const { randomUUID } = require('node:crypto');
const { SimulatedCrash } = require('../../src/worker/errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A valid billing request. Every call gets its own requestId and idempotency key. */
function buildRequest(overrides = {}) {
  return {
    requestId: randomUUID(),
    contractVersion: '1.0',
    operation: 'STANDARD_INVOICE',
    idempotencyKey: `BILL-${randomUUID()}`,
    customerId: 'C-1001',
    callbackUrl: 'http://127.0.0.1:9/callbacks',
    payload: { items: [{ sku: 'SKU-001', quantity: 2 }] },
    ...overrides,
  };
}

function items(count, quantity = 1) {
  return Array.from({ length: count }, () => ({ sku: 'SKU-001', quantity }));
}

/** Hook that kills the worker once, the first time the predicate matches. */
function crashOnce(predicate) {
  let crashed = false;
  return async (context) => {
    if (!crashed && predicate(context)) {
      crashed = true;
      throw new SimulatedCrash();
    }
  };
}

/** [first createdAt, last createdAt] of every ERP document created for a reference. */
function timeWindow(docs) {
  const times = [...docs.salesOrders, ...docs.deliveries, ...docs.invoices].map((d) => d.createdAt);
  return { start: Math.min(...times), end: Math.max(...times) };
}

const overlaps = (a, b) => !(a.end < b.start || b.end < a.start);

module.exports = { buildRequest, items, crashOnce, sleep, timeWindow, overlaps };
