'use strict';

const { expect } = require('chai');
const { createHarness } = require('./support/harness');

describe('Billing operations: happy path', () => {
  let h;
  afterEach(() => h?.close());

  it('STANDARD_INVOICE creates order -> delivery -> invoice, in this order, and reports SUCCESS', async () => {
    h = await createHarness();
    const req = h.request();
    h.publish(req);

    const [outcome] = await h.drain();
    expect(outcome).to.include({ outcome: 'SUCCESS', deliveryCount: 1 });

    const docs = await h.documents(req.idempotencyKey);
    expect(docs.salesOrders).to.have.length(1);
    expect(docs.deliveries).to.have.length(1);
    expect(docs.invoices).to.have.length(1);
    const [order, delivery, invoice] = [docs.salesOrders[0], docs.deliveries[0], docs.invoices[0]];
    expect(delivery.salesOrderId).to.equal(order.salesOrderId);
    expect(invoice).to.include({ salesOrderId: order.salesOrderId, deliveryId: delivery.deliveryId });
    expect(order.createdAt).to.be.at.most(delivery.createdAt);
    expect(delivery.createdAt).to.be.at.most(invoice.createdAt);

    expect(h.callbacks).to.have.length(1);
    expect(h.callbacks[0].documents).to.deep.equal({
      salesOrderId: order.salesOrderId,
      deliveryId: delivery.deliveryId,
      invoiceId: invoice.invoiceId,
      fiscalNumber: invoice.fiscalNumber,
    });
  });

  it('SERVICE_INVOICE skips the delivery and invoices the order directly', async () => {
    h = await createHarness();
    const req = h.request({ operation: 'SERVICE_INVOICE' });
    h.publish(req);
    await h.drain();

    const docs = await h.documents(req.idempotencyKey);
    expect(docs.salesOrders).to.have.length(1);
    expect(docs.deliveries).to.have.length(0);
    expect(docs.invoices).to.have.length(1);
    expect(docs.invoices[0].deliveryId).to.equal(null);
    expect(h.callbacks[0].documents).to.not.have.property('deliveryId');
  });

  it('settles the message and marks the key COMPLETED after success', async () => {
    h = await createHarness();
    const req = h.request();
    h.publish(req);
    await h.drain();

    expect(h.queue.activeCount).to.equal(0);
    expect(h.queue.deadLetters).to.have.length(0);
    const record = h.store.get(req.idempotencyKey);
    expect(record.status).to.equal('COMPLETED');
    expect(record.result.status).to.equal('SUCCESS');
  });

  it('two workers bill several customers in parallel, each request exactly once', async () => {
    h = await createHarness({ workerCount: 2, erpLatencyMs: 5 });
    const requests = ['C-1001', 'C-1002', 'C-1003', 'C-1001', 'C-1002'].map((customerId) => h.request({ customerId }));
    requests.forEach((req) => h.publish(req));

    const outcomes = await h.drain();
    expect(outcomes.map((o) => o.outcome)).to.deep.equal(Array(5).fill('SUCCESS'));
    expect(new Set(outcomes.map((o) => o.worker)).size, 'both workers did work').to.equal(2);

    const stats = await h.stats();
    expect(stats.totals).to.deep.equal({ salesOrders: 5, deliveries: 5, invoices: 5 });
    for (const req of requests) {
      expect((await h.documents(req.idempotencyKey)).invoices, req.idempotencyKey).to.have.length(1);
    }
    expect(h.callbacks.map((c) => c.idempotencyKey)).to.have.members(requests.map((r) => r.idempotencyKey));
  });
});
