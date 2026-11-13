'use strict';

const { TechnicalError } = require('./errors');

/** POSTs the result to the requester. Retries a few times, then reports a technical failure. */
async function postCallback(url, body, { timeoutMs = 2000, retries = 2 } = {}) {
  let lastError = 'unknown error';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
  }
  throw new TechnicalError('CALLBACK_FAILED', `Callback failed after ${retries + 1} tries: ${lastError}`);
}

module.exports = { postCallback };
