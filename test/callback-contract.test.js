'use strict';

const { expect } = require('chai');
const { createHarness } = require('./support/harness');
const { validateCallback } = require('../src/contracts/validator');

// Risk R3: the requester cannot parse or trust the result. Every status must follow the same contract.
describe('Callback contract (billing-callback-v1)', () => {
  let h;
  afterEach(() => h?.close());

  async function callbackFor(overrides, fault) {
    h = await createHarness();
    if (fault) await h.fault(fault);
    const req = h.request(overrides);
    h.publish(req);
    await h.drain();
    expect(h.callbacks).to.have.length(1);
    return { req, callback: h.callbacks[0] };
  }

  it('SUCCESS matches the schema and carries all document ids', async () => {
    const { callback } = await callbackFor({});
    expect(validateCallback(callback).errors).to.deep.equal([]);
    expect(callback.documents).to.have.all.keys('salesOrderId', 'deliveryId', 'invoiceId', 'fiscalNumber');
  });

  it('BUSINESS_ERROR matches the schema and has no documents', async () => {
    const { callback } = await callbackFor({ customerId: 'C-2001' });
    expect(validateCallback(callback).errors).to.deep.equal([]);
    expect(callback).to.not.have.property('documents');
    expect(callback.messages[0]).to.contain('blocked');
  });

  it('TECHNICAL_ERROR matches the schema and reports the final attempt number', async () => {
    const { callback } = await callbackFor({}, { route: 'POST /sales-orders', mode: 'error', times: 99 });
    expect(validateCallback(callback).errors).to.deep.equal([]);
    expect(callback).to.include({ status: 'TECHNICAL_ERROR', attempt: 3 });
  });

  it('echoes requestId, idempotencyKey and operation so the requester can correlate the answer', async () => {
    const { req, callback } = await callbackFor({ operation: 'SERVICE_INVOICE' });
    expect(callback).to.include({
      requestId: req.requestId,
      idempotencyKey: req.idempotencyKey,
      operation: 'SERVICE_INVOICE',
    });
    expect(Date.parse(callback.completedAt)).to.not.be.NaN;
  });

  describe('The schema itself rejects broken results (the contract check can fail)', () => {
    const valid = {
      requestId: 'r-1',
      idempotencyKey: 'BILL-00000001',
      operation: 'STANDARD_INVOICE',
      status: 'SUCCESS',
      code: 'OK',
      messages: ['Billing completed'],
      documents: { salesOrderId: 'SO-0000001', invoiceId: 'IN-0000001', fiscalNumber: 'FD-000000001' },
      attempt: 1,
      completedAt: '2026-01-01T00:00:00.000Z',
    };

    it('accepts a well-formed SUCCESS result (control)', () => {
      expect(validateCallback(valid).valid).to.equal(true);
    });

    it('rejects SUCCESS without documents', () => {
      const { documents, ...broken } = valid;
      expect(validateCallback(broken).valid).to.equal(false);
    });

    it('rejects an error result that carries documents', () => {
      expect(validateCallback({ ...valid, status: 'BUSINESS_ERROR', code: 'CUSTOMER_BLOCKED' }).valid).to.equal(false);
    });

    it('rejects an unknown status', () => {
      expect(validateCallback({ ...valid, status: 'PARTIAL' }).valid).to.equal(false);
    });
  });
});
