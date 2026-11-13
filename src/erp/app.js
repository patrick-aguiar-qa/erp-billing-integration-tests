'use strict';

const express = require('express');

/*
 * Fake ERP with an order-to-cash flow: sales order -> delivery -> invoice.
 * Like many real ERPs, it does NOT reject two documents with the same reference.
 * Preventing duplicates is the job of the integration, which is what the tests verify.
 *
 * Amounts are integer cents. Customers and prices are fictional.
 */
const CUSTOMERS = {
  'C-1001': { status: 'ACTIVE', creditLimitCents: 1_000_000_000 },
  'C-1002': { status: 'ACTIVE', creditLimitCents: 1_000_000_000 },
  'C-1003': { status: 'ACTIVE', creditLimitCents: 1_000_000_000 },
  'C-2001': { status: 'BLOCKED', creditLimitCents: 1_000_000_000 },
  'C-3001': { status: 'ACTIVE', creditLimitCents: 100_000 },
};

const CATALOG_CENTS = {
  'SKU-001': 4_590,
  'SKU-002': 12_000,
  'SKU-003': 89_900,
  'SKU-004': 50_000,
  'SKU-005': 1,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (n, size) => String(n).padStart(size, '0');

function freshState(latencyMs) {
  return {
    latencyMs,
    seq: { salesOrder: 0, delivery: 0, invoice: 0 },
    salesOrders: [],
    deliveries: [],
    invoices: [],
    faults: [],
    requests: {},
  };
}

/** Latency, request counting and fault injection (test seam). */
function simulation(state) {
  return async (req, res, next) => {
    if (req.path.startsWith('/__test')) return next();

    const route = `${req.method} ${req.path}`;
    state.requests[route] = (state.requests[route] ?? 0) + 1;
    if (state.latencyMs) await sleep(state.latencyMs);

    const fault = state.faults.find((f) => f.route === route && f.remaining > 0);
    if (fault) {
      fault.remaining -= 1;
      if (fault.mode === 'error') {
        return res.status(fault.status ?? 503).json({ code: 'ERP_UNAVAILABLE', message: 'Simulated ERP outage' });
      }
      if (fault.mode === 'slow') await sleep(fault.delayMs);
      if (fault.mode === 'timeout-after-commit') req.responseDelayMs = fault.delayMs;
    }
    return next();
  };
}

/** Sends the response, optionally late: the document is already committed when the client gives up. */
function respond(req, res, status, body) {
  const send = () => {
    if (!res.headersSent && !res.writableEnded) res.status(status).json(body);
  };
  if (req.responseDelayMs) setTimeout(send, req.responseDelayMs);
  else send();
}

function createErpApp({ latencyMs = 0 } = {}) {
  let state = freshState(latencyMs);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => simulation(state)(req, res, next));

  app.get('/health', (req, res) => res.json({ status: 'UP' }));

  app.post('/sales-orders', (req, res) => {
    const { customerId, reference, items } = req.body ?? {};
    if (typeof customerId !== 'string' || typeof reference !== 'string' || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'customerId, reference and a non-empty items array are required',
      });
    }
    if (items.some((i) => !Number.isInteger(i?.quantity) || i.quantity < 1)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'quantity must be a positive integer' });
    }

    const customer = CUSTOMERS[customerId];
    if (!customer) {
      return res.status(422).json({ code: 'CUSTOMER_NOT_FOUND', message: `Customer ${customerId} does not exist` });
    }
    if (customer.status === 'BLOCKED') {
      return res.status(422).json({ code: 'CUSTOMER_BLOCKED', message: `Customer ${customerId} is blocked for billing` });
    }

    const unknown = items.find((i) => !(i.sku in CATALOG_CENTS));
    if (unknown) {
      return res.status(422).json({ code: 'UNKNOWN_SKU', message: `SKU ${unknown.sku} is not in the catalog` });
    }

    const totalCents = items.reduce((sum, i) => sum + CATALOG_CENTS[i.sku] * i.quantity, 0);
    if (totalCents > customer.creditLimitCents) {
      return res.status(422).json({
        code: 'CREDIT_LIMIT_EXCEEDED',
        message: `Order total ${totalCents} exceeds the credit limit ${customer.creditLimitCents}`,
      });
    }

    state.seq.salesOrder += 1;
    const order = {
      salesOrderId: `SO-${pad(state.seq.salesOrder, 7)}`,
      customerId,
      reference,
      items,
      totalCents,
      createdAt: Date.now(),
    };
    state.salesOrders.push(order);
    return respond(req, res, 201, { salesOrderId: order.salesOrderId, totalCents });
  });

  app.post('/deliveries', (req, res) => {
    const order = state.salesOrders.find((o) => o.salesOrderId === req.body?.salesOrderId);
    if (!order) return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'Sales order not found' });

    state.seq.delivery += 1;
    const delivery = {
      deliveryId: `DL-${pad(state.seq.delivery, 7)}`,
      salesOrderId: order.salesOrderId,
      reference: order.reference,
      createdAt: Date.now(),
    };
    state.deliveries.push(delivery);
    return respond(req, res, 201, { deliveryId: delivery.deliveryId });
  });

  app.post('/invoices', (req, res) => {
    const { salesOrderId, deliveryId } = req.body ?? {};
    const order = state.salesOrders.find((o) => o.salesOrderId === salesOrderId);
    if (!order) return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'Sales order not found' });

    if (deliveryId !== undefined) {
      const delivery = state.deliveries.find((d) => d.deliveryId === deliveryId);
      if (!delivery || delivery.salesOrderId !== salesOrderId) {
        return res.status(422).json({ code: 'DELIVERY_MISMATCH', message: 'Delivery does not belong to the sales order' });
      }
    }

    state.seq.invoice += 1;
    const invoice = {
      invoiceId: `IN-${pad(state.seq.invoice, 7)}`,
      fiscalNumber: `FD-${pad(state.seq.invoice, 9)}`,
      salesOrderId,
      deliveryId: deliveryId ?? null,
      reference: order.reference,
      createdAt: Date.now(),
    };
    state.invoices.push(invoice);
    return respond(req, res, 201, { invoiceId: invoice.invoiceId, fiscalNumber: invoice.fiscalNumber });
  });

  app.get('/documents', (req, res) => {
    const { reference } = req.query;
    if (!reference) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'reference is required' });
    const byRef = (doc) => doc.reference === reference;
    return res.json({
      salesOrders: state.salesOrders.filter(byRef),
      deliveries: state.deliveries.filter(byRef),
      invoices: state.invoices.filter(byRef),
    });
  });

  // ---- test-only endpoints -------------------------------------------------
  app.post('/__test/faults', (req, res) => {
    const { route, mode, times = 1, status, delayMs = 0 } = req.body ?? {};
    if (!route || !['error', 'slow', 'timeout-after-commit'].includes(mode)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'route and a valid mode are required' });
    }
    state.faults.push({ route, mode, remaining: times, status, delayMs });
    return res.status(201).json({ route, mode, times });
  });

  app.get('/__test/stats', (req, res) =>
    res.json({
      requests: state.requests,
      totals: {
        salesOrders: state.salesOrders.length,
        deliveries: state.deliveries.length,
        invoices: state.invoices.length,
      },
    }),
  );

  app.post('/__test/reset', (req, res) => {
    state = freshState(state.latencyMs);
    res.status(204).end();
  });

  return app;
}

module.exports = { createErpApp, CUSTOMERS, CATALOG_CENTS };
