'use strict';

const { expect } = require('chai');
const { createHarness } = require('./support/harness');
const { crashOnce, timeWindow, overlaps } = require('./support/builders');

// A test that cannot fail proves nothing. Here each safeguard is switched off, one at a time,
// and the same scenario from duplicate-protection.test.js is replayed: it MUST produce a duplicate
// (or an overlap). If one of these tests ever fails, the matching protection test is not testing anything.
describe('Negative control: each safeguard is load-bearing', () => {
  let h;
  afterEach(() => h?.close());

  it('without broker duplicate detection AND without the idempotency store, a resent request bills twice', async () => {
    h = await createHarness({
      queueOptions: { duplicateDetection: false },
      safeguards: { idempotency: false },
    });
    const req = h.request();
    h.publish(req);
    h.publish(req);
    await h.drain();

    expect((await h.documents(req.idempotencyKey)).invoices).to.have.length(2);
  });

  it('without reconciliation, a crash after the sales order commit creates a second sales order', async () => {
    h = await createHarness({
      queueOptions: { lockDurationMs: 150 },
      safeguards: { reconcile: false },
      hooks: { afterErpCommit: crashOnce((ctx) => ctx.step === 'salesOrder') },
    });
    const req = h.request();
    h.publish(req);
    await h.drain();

    expect((await h.documents(req.idempotencyKey)).salesOrders).to.have.length(2);
  });

  it('without reconciliation, an ERP timeout after commit creates a second invoice', async () => {
    h = await createHarness({ erpTimeoutMs: 150, safeguards: { reconcile: false } });
    await h.fault({ route: 'POST /invoices', mode: 'timeout-after-commit', delayMs: 400 });
    const req = h.request();
    h.publish(req);
    await h.drain();

    expect((await h.documents(req.idempotencyKey)).invoices).to.have.length(2);
  });

  it('without the idempotency store, a crash after the callback bills the request again', async () => {
    h = await createHarness({
      queueOptions: { lockDurationMs: 150 },
      safeguards: { idempotency: false },
      hooks: { afterCallback: crashOnce(() => true) },
    });
    const req = h.request();
    h.publish(req);
    await h.drain();

    expect((await h.documents(req.idempotencyKey)).invoices).to.have.length(2);
  });

  it('without lock renewal, a slow ERP call lets a second worker bill the same message', async () => {
    h = await createHarness({
      workerCount: 2,
      queueOptions: { lockDurationMs: 300 },
      erpTimeoutMs: 3000,
      safeguards: { renewLock: false },
    });
    await h.fault({ route: 'POST /sales-orders', mode: 'slow', delayMs: 1000 });
    const req = h.request();
    h.publish(req);

    const outcomes = await h.drain();
    expect(outcomes.map((o) => o.outcome)).to.have.members(['SUCCESS', 'LOCK_LOST']);
    expect((await h.documents(req.idempotencyKey)).invoices).to.have.length(2);
  });

  it('without broker sessions, two requests for the same customer run at the same time', async () => {
    h = await createHarness({ workerCount: 2, erpLatencyMs: 30, queueOptions: { sessions: false } });
    const first = h.request({ customerId: 'C-1001' });
    const second = h.request({ customerId: 'C-1001' });
    h.publish(first);
    h.publish(second);
    await h.drain();

    const a = timeWindow(await h.documents(first.idempotencyKey));
    const b = timeWindow(await h.documents(second.idempotencyKey));
    expect(overlaps(a, b)).to.equal(true);
  });
});
