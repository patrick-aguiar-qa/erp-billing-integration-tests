'use strict';

/** The ERP refused the request because of a business rule. Retrying the same data will not help. */
class BusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
  }
}

/** Infrastructure or integration failure (timeout, outage, callback down). Safe to retry. */
class TechnicalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TechnicalError';
    this.code = code;
  }
}

/** Test seam: simulates the worker process dying at a precise point (no cleanup, no settlement). */
class SimulatedCrash extends Error {
  constructor(message = 'Simulated worker crash') {
    super(message);
    this.name = 'SimulatedCrash';
  }
}

module.exports = { BusinessError, TechnicalError, SimulatedCrash };
