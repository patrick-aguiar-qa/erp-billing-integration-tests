'use strict';

const { expect } = require('chai');
const request = require('supertest');
const { createErpApp } = require('../src/erp/app');

// The fake ERP is a test double, but the worker depends on its behavior,
// so its API contract is tested on its own first.
describe('Fake ERP API', () => {
  let erp;
  const order = (overrides = {}) => ({
    customerId: 'C-1001',
    reference: 'REF-0001',
    items: [{ sku: 'SKU-001', quantity: 2 }],
    ...overrides,
  });

  beforeEach(() => {
    erp = request(createErpApp());
  });

  it('GET /health reports the ERP as UP', async () => {
    const res = await erp.get('/health').expect(200);
    expect(res.body).to.deep.equal({ status: 'UP' });
  });

  describe('POST /sales-orders', () => {
    it('creates an order and returns its id and total in cents', async () => {
      const res = await erp.post('/sales-orders').send(order()).expect(201);
      expect(res.body.salesOrderId).to.match(/^SO-\d{7}$/);
      expect(res.body.totalCents).to.equal(2 * 4590);
    });

    it('returns 400 when items is empty', async () => {
      const res = await erp.post('/sales-orders').send(order({ items: [] })).expect(400);
      expect(res.body.code).to.equal('VALIDATION_ERROR');
    });

    it('returns 400 when a quantity is zero', async () => {
      const res = await erp.post('/sales-orders').send(order({ items: [{ sku: 'SKU-001', quantity: 0 }] })).expect(400);
      expect(res.body.code).to.equal('VALIDATION_ERROR');
    });

    it('returns 422 CUSTOMER_NOT_FOUND for an unknown customer', async () => {
      const res = await erp.post('/sales-orders').send(order({ customerId: 'C-9999' })).expect(422);
      expect(res.body.code).to.equal('CUSTOMER_NOT_FOUND');
    });

    it('returns 422 CUSTOMER_BLOCKED for a blocked customer', async () => {
      const res = await erp.post('/sales-orders').send(order({ customerId: 'C-2001' })).expect(422);
      expect(res.body.code).to.equal('CUSTOMER_BLOCKED');
    });

    it('returns 422 UNKNOWN_SKU for a product outside the catalog', async () => {
      const res = await erp.post('/sales-orders').send(order({ items: [{ sku: 'SKU-999', quantity: 1 }] })).expect(422);
      expect(res.body.code).to.equal('UNKNOWN_SKU');
    });

    // Boundary value analysis on the credit limit of C-3001 (100,000 cents).
    it('accepts an order whose total is exactly the credit limit', async () => {
      const res = await erp
        .post('/sales-orders')
        .send(order({ customerId: 'C-3001', items: [{ sku: 'SKU-004', quantity: 2 }] }))
        .expect(201);
      expect(res.body.totalCents).to.equal(100_000);
    });

    it('rejects an order one cent above the credit limit with CREDIT_LIMIT_EXCEEDED', async () => {
      const res = await erp
        .post('/sales-orders')
        .send(
          order({
            customerId: 'C-3001',
            items: [
              { sku: 'SKU-004', quantity: 2 },
              { sku: 'SKU-005', quantity: 1 },
            ],
          }),
        )
        .expect(422);
      expect(res.body.code).to.equal('CREDIT_LIMIT_EXCEEDED');
    });

    it('does NOT deduplicate by reference: preventing duplicates is the integration\'s job', async () => {
      await erp.post('/sales-orders').send(order({ reference: 'REF-DUP' })).expect(201);
      await erp.post('/sales-orders').send(order({ reference: 'REF-DUP' })).expect(201);
      const res = await erp.get('/documents').query({ reference: 'REF-DUP' }).expect(200);
      expect(res.body.salesOrders).to.have.length(2);
    });
  });

  describe('POST /deliveries and POST /invoices', () => {
    it('returns 404 ORDER_NOT_FOUND for a delivery of an unknown order', async () => {
      const res = await erp.post('/deliveries').send({ salesOrderId: 'SO-0000099' }).expect(404);
      expect(res.body.code).to.equal('ORDER_NOT_FOUND');
    });

    it('returns 422 DELIVERY_MISMATCH when the delivery belongs to another order', async () => {
      const first = (await erp.post('/sales-orders').send(order({ reference: 'REF-A' })).expect(201)).body;
      const second = (await erp.post('/sales-orders').send(order({ reference: 'REF-B' })).expect(201)).body;
      const delivery = (await erp.post('/deliveries').send({ salesOrderId: first.salesOrderId }).expect(201)).body;

      const res = await erp
        .post('/invoices')
        .send({ salesOrderId: second.salesOrderId, deliveryId: delivery.deliveryId })
        .expect(422);
      expect(res.body.code).to.equal('DELIVERY_MISMATCH');
    });

    it('links order, delivery and invoice through the reference', async () => {
      const { salesOrderId } = (await erp.post('/sales-orders').send(order({ reference: 'REF-LINK' })).expect(201)).body;
      const { deliveryId } = (await erp.post('/deliveries').send({ salesOrderId }).expect(201)).body;
      const invoice = (await erp.post('/invoices').send({ salesOrderId, deliveryId }).expect(201)).body;
      expect(invoice.fiscalNumber).to.match(/^FD-\d{9}$/);

      const docs = (await erp.get('/documents').query({ reference: 'REF-LINK' }).expect(200)).body;
      expect(docs.deliveries[0].salesOrderId).to.equal(salesOrderId);
      expect(docs.invoices[0]).to.include({ salesOrderId, deliveryId, invoiceId: invoice.invoiceId });
    });
  });

  it('GET /documents returns 400 without a reference', async () => {
    const res = await erp.get('/documents').expect(400);
    expect(res.body.code).to.equal('VALIDATION_ERROR');
  });
});
