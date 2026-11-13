'use strict';

/** Each operation is an ordered list of ERP steps. */
const OPERATIONS = {
  STANDARD_INVOICE: ['salesOrder', 'delivery', 'invoice'],
  SERVICE_INVOICE: ['salesOrder', 'invoice'],
};

const STEPS = {
  salesOrder: {
    isDone: (docs) => Boolean(docs.salesOrderId),
    async run(erp, request) {
      const { salesOrderId } = await erp.createSalesOrder({
        customerId: request.customerId,
        reference: request.idempotencyKey, // lets the worker find this document again after a failure
        items: request.payload.items,
      });
      return { salesOrderId };
    },
  },
  delivery: {
    isDone: (docs) => Boolean(docs.deliveryId),
    async run(erp, request, docs) {
      const { deliveryId } = await erp.createDelivery({ salesOrderId: docs.salesOrderId });
      return { deliveryId };
    },
  },
  invoice: {
    isDone: (docs) => Boolean(docs.invoiceId),
    async run(erp, request, docs) {
      const { invoiceId, fiscalNumber } = await erp.createInvoice({
        salesOrderId: docs.salesOrderId,
        deliveryId: docs.deliveryId,
      });
      return { invoiceId, fiscalNumber };
    },
  },
};

module.exports = { OPERATIONS, STEPS };
