'use strict';

const { expect } = require('chai');
const { createHarness } = require('./support/harness');

// Risks R2 and R3: errors are misclassified (business errors retried forever,
// technical errors given up too early) or the requester is never told the result.
describe('Error classification, retries and dead-lettering', () => {
  let h;
  afterEach(() => h?.close());

  describe('Business errors: not retried', () => {
    const businessCases = [
      ['a blocked customer', { customerId: 'C-2001' }, 'CUSTOMER_BLOCKED'],
      ['an order above the credit limit', { customerId: 'C-3001', payload: { items: [{ sku: 'SKU-003', quantity: 2 }] } }, 'CREDIT_LIMIT_EXCEEDED'],
      ['a SKU missing from the ERP catalog', { payload: { items: [{ sku: 'SKU-999', quantity: 1 }] } }, 'UNKNOWN_SKU'],
    ];

    for (const [label, overrides, code] of businessCases) {
      it(`${label} -> BUSINESS_ERROR ${code} on the first delivery, message completed`, async () => {
        h = await createHarness();
        h.publish(h.request(overrides));

        const outcomes = await h.drain();
        expect(outcomes).to.have.length(1);
        expect(outcomes[0]).to.include({ outcome: 'BUSINESS_ERROR', code, deliveryCount: 1 });
        expect(h.queue.deadLetters).to.have.length(0);
        expect((await h.stats()).requests['POST /sales-orders']).to.equal(1);
        expect(h.callbacks).to.have.length(1);
        expect(h.callbacks[0]).to.include({ status: 'BUSINESS_ERROR', code });
      });
    }
  });

  describe('Technical errors: retried, then dead-lettered', () => {
    it('a transient ERP outage is retried and succeeds, with a single SUCCESS callback', async () => {
      h = await createHarness();
      await h.fault({ route: 'POST /deliveries', mode: 'error', status: 503, times: 1 });
      const req = h.request();
      h.publish(req);

      const outcomes = await h.drain();
      expect(outcomes.map((o) => o.outcome)).to.deep.equal(['RETRY', 'SUCCESS']);
      expect(outcomes[0].code).to.equal('ERP_UNAVAILABLE');
      expect(h.callbacks).to.have.length(1);
      expect(h.callbacks[0]).to.include({ status: 'SUCCESS', attempt: 2 });
    });

    it('a persistent ERP outage is dead-lettered after maxDeliveryCount with one TECHNICAL_ERROR callback', async () => {
      h = await createHarness();
      await h.fault({ route: 'POST /sales-orders', mode: 'error', status: 503, times: 99 });
      const req = h.request();
      h.publish(req);

      const outcomes = await h.drain();
      expect(outcomes.map((o) => o.outcome)).to.deep.equal(['RETRY', 'RETRY', 'DEAD_LETTERED']);
      expect(h.queue.deadLetters).to.have.length(1);
      expect(h.queue.deadLetters[0]).to.include({ reason: 'ERP_UNAVAILABLE', deliveryCount: 3 });
      expect(h.callbacks).to.have.length(1);
      expect(h.callbacks[0]).to.include({ status: 'TECHNICAL_ERROR', code: 'ERP_UNAVAILABLE', attempt: 3 });
      expect(h.store.get(req.idempotencyKey).status).to.equal('FAILED');
    });

    it('an ERP that answers too slowly is a technical error (ERP_TIMEOUT), not a business error', async () => {
      h = await createHarness({ erpTimeoutMs: 100 });
      await h.fault({ route: 'POST /deliveries', mode: 'slow', delayMs: 300, times: 99 });
      h.publish(h.request());

      const outcomes = await h.drain();
      expect(outcomes.map((o) => o.code)).to.deep.equal(['ERP_TIMEOUT', 'ERP_TIMEOUT', 'ERP_TIMEOUT']);
      expect(h.callbacks[0]).to.include({ status: 'TECHNICAL_ERROR', code: 'ERP_TIMEOUT' });
    });
  });

  describe('Callback failures', () => {
    it('requester down for a moment: the result is resent on the next delivery, the ERP is not called again', async () => {
      h = await createHarness();
      h.receiver.failNext = 3; // 1 try + 2 quick retries all fail on the first delivery
      const req = h.request();
      h.publish(req);

      const outcomes = await h.drain();
      expect(outcomes.map((o) => o.outcome)).to.deep.equal(['CALLBACK_RETRY', 'DUPLICATE_RESENT']);
      expect(h.receiver.rejected).to.equal(3);
      expect(h.callbacks).to.have.length(1);
      expect((await h.stats()).totals).to.deep.equal({ salesOrders: 1, deliveries: 1, invoices: 1 });
    });

    it('requester down for good: dead-lettered as CALLBACK_FAILED, but the billing stays recorded as done', async () => {
      h = await createHarness();
      h.receiver.failNext = 999;
      const req = h.request();
      h.publish(req);

      const outcomes = await h.drain();
      expect(outcomes.map((o) => o.outcome)).to.deep.equal(['CALLBACK_RETRY', 'CALLBACK_RETRY', 'DEAD_LETTERED']);
      expect(h.queue.deadLetters[0].reason).to.equal('CALLBACK_FAILED');
      expect(h.store.get(req.idempotencyKey).status).to.equal('COMPLETED');
      expect((await h.stats()).totals.invoices).to.equal(1);
    });
  });
});
