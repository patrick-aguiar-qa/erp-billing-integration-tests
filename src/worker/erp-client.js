'use strict';

const { BusinessError, TechnicalError } = require('./errors');

/** HTTP client for the ERP. Translates responses into business vs. technical errors. */
class ErpClient {
  constructor({ baseUrl, timeoutMs = 2000 }) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async #request(method, path, body) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') {
        throw new TechnicalError('ERP_TIMEOUT', `ERP did not answer within ${this.timeoutMs} ms`);
      }
      throw new TechnicalError('ERP_UNREACHABLE', err.message);
    }

    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    if (res.status === 422) {
      throw new BusinessError(data.code ?? 'ERP_BUSINESS_RULE', data.message ?? 'Rejected by an ERP business rule');
    }
    throw new TechnicalError(data.code ?? `ERP_HTTP_${res.status}`, data.message ?? `ERP answered HTTP ${res.status}`);
  }

  createSalesOrder(body) {
    return this.#request('POST', '/sales-orders', body);
  }

  createDelivery(body) {
    return this.#request('POST', '/deliveries', body);
  }

  createInvoice(body) {
    return this.#request('POST', '/invoices', body);
  }

  findDocuments(reference) {
    return this.#request('GET', `/documents?reference=${encodeURIComponent(reference)}`);
  }
}

module.exports = { ErpClient };
