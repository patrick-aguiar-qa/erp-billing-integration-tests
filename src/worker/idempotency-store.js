'use strict';

/**
 * Idempotency store: one record per idempotency key.
 *
 *   (none) -> IN_PROGRESS -> COMPLETED   result stored, never processed again
 *                         -> FAILED      technical failure, may be resubmitted
 *
 * The record is written BEFORE the first ERP call, so a redelivered message knows that
 * a previous attempt may have written to the ERP. In production this is a database table
 * with a unique constraint on the key; here a Map is enough because Node runs one thread.
 */
class IdempotencyStore {
  #records = new Map();

  get(key) {
    const record = this.#records.get(key);
    return record && structuredClone(record);
  }

  start(key, requestId) {
    const previous = this.#records.get(key);
    if (previous?.status === 'COMPLETED') throw new Error(`Key ${key} is already completed`);
    this.#records.set(key, {
      requestId,
      status: 'IN_PROGRESS',
      attempts: (previous?.attempts ?? 0) + 1,
      documents: { ...(previous?.documents ?? {}) },
      result: null,
    });
  }

  checkpoint(key, documents) {
    this.#records.get(key).documents = { ...documents };
  }

  complete(key, result) {
    const record = this.#records.get(key);
    Object.assign(record, { status: 'COMPLETED', result, documents: { ...(result.documents ?? record.documents) } });
  }

  fail(key, result) {
    Object.assign(this.#records.get(key), { status: 'FAILED', result });
  }
}

module.exports = { IdempotencyStore };
