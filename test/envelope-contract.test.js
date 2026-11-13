'use strict';

const { expect } = require('chai');
const { createHarness } = require('./support/harness');
const { items } = require('./support/builders');
const { validateCallback } = require('../src/contracts/validator');

// Risk R4: a malformed request reaches the ERP. Every invalid envelope must be stopped
// before any ERP call, dead-lettered, and answered with INVALID_ENVELOPE when possible.
describe('Request envelope validation', () => {
  let h;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.close());

  async function processSingle(request, publishOptions) {
    h.publish(request, publishOptions);
    const [outcome] = await h.drain();
    return outcome;
  }

  async function expectRejected(request, publishOptions) {
    const outcome = await processSingle(request, publishOptions);
    expect(outcome.outcome).to.equal('INVALID_ENVELOPE');
    expect(h.queue.deadLetters).to.have.length(1);
    expect(h.queue.deadLetters[0].reason).to.equal('INVALID_ENVELOPE');
    const stats = await h.stats();
    expect(stats.requests['POST /sales-orders'], 'no ERP call for an invalid envelope').to.equal(undefined);
    return outcome;
  }

  describe('Equivalence partitions: invalid classes are rejected', () => {
    const invalidCases = [
      ['an unsupported operation', { operation: 'CREDIT_NOTE' }],
      ['an unsupported contract version', { contractVersion: '2.0' }],
      ['a customerId outside the C-0000 format', { customerId: '1001' }],
      ['an unknown top-level field', { priority: 'HIGH' }],
      ['an item with a non-integer quantity', { payload: { items: [{ sku: 'SKU-001', quantity: 1.5 }] } }],
      ['an item with an invalid SKU format', { payload: { items: [{ sku: 'ABC', quantity: 1 }] } }],
    ];

    for (const [label, overrides] of invalidCases) {
      it(`rejects a request with ${label}`, async () => {
        const req = h.request(overrides);
        const outcome = await expectRejected(req, { sessionId: req.customerId });
        expect(outcome.callbackSent).to.equal(true);
        expect(h.callbacks[0]).to.include({ status: 'BUSINESS_ERROR', code: 'INVALID_ENVELOPE', requestId: req.requestId });
        expect(validateCallback(h.callbacks[0]).errors).to.deep.equal([]);
      });
    }

    it('rejects a request whose idempotencyKey differs from the broker messageId', async () => {
      const req = h.request();
      const outcome = await expectRejected(req, { messageId: 'BILL-OTHER-ID-1234' });
      expect(outcome.errors).to.include('idempotencyKey must be equal to the broker messageId');
    });

    it('rejects a request whose customerId differs from the broker sessionId', async () => {
      const req = h.request();
      const outcome = await expectRejected(req, { sessionId: 'C-1002' });
      expect(outcome.errors).to.include('customerId must be equal to the broker sessionId');
    });
  });

  describe('Boundary values', () => {
    const boundaryCases = [
      ['items count', 0, { payload: { items: [] } }, false],
      ['items count', 1, { payload: { items: items(1) } }, true],
      ['items count', 50, { payload: { items: items(50) } }, true],
      ['items count', 51, { payload: { items: items(51) } }, false],
      ['quantity', 0, { payload: { items: items(1, 0) } }, false],
      ['quantity', 1, { payload: { items: items(1, 1) } }, true],
      ['quantity', 9999, { payload: { items: items(1, 9999) } }, true],
      ['quantity', 10000, { payload: { items: items(1, 10000) } }, false],
      ['idempotencyKey length', 7, { idempotencyKey: 'K'.repeat(7) }, false],
      ['idempotencyKey length', 8, { idempotencyKey: 'K'.repeat(8) }, true],
      ['idempotencyKey length', 64, { idempotencyKey: 'K'.repeat(64) }, true],
      ['idempotencyKey length', 65, { idempotencyKey: 'K'.repeat(65) }, false],
    ];

    for (const [field, value, overrides, accepted] of boundaryCases) {
      it(`${accepted ? 'accepts' : 'rejects'} ${field} = ${value}`, async () => {
        const req = h.request(overrides);
        if (accepted) {
          const outcome = await processSingle(req);
          expect(outcome.outcome).to.equal('SUCCESS');
        } else {
          await expectRejected(req);
        }
      });
    }
  });

  describe('When the requester cannot be answered', () => {
    it('dead-letters without a callback when callbackUrl is not http(s)', async () => {
      const outcome = await expectRejected(h.request({ callbackUrl: 'ftp://example.test/callbacks' }));
      expect(outcome.callbackSent).to.equal(false);
      expect(h.callbacks).to.have.length(0);
    });

    it('dead-letters without a callback when requestId is missing', async () => {
      const req = h.request();
      delete req.requestId;
      const outcome = await expectRejected(req);
      expect(outcome.callbackSent).to.equal(false);
      expect(h.callbacks).to.have.length(0);
    });
  });
});
