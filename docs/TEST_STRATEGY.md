# Test Strategy — ERP Billing Integration

## 1. Scope

**In scope:** the billing worker and how it interacts with the queue, the idempotency store,
the ERP API and the requester's callback.

**Out of scope:** the ERP's internal logic (only its API contract is checked), real broker
infrastructure, the UI of the source system, performance and security testing.

**Test level:** component integration. Every dependency is real code running in-process
(Express servers on random ports, an in-memory queue), not a mock object. Failures are produced
through explicit fault injection.

## 2. Risk analysis

| ID | Risk | Likelihood | Impact | Priority |
|---|---|---|---|---|
| R1 | The same request creates a second fiscal document | Medium: at-least-once delivery, crashes and timeouts are normal in distributed systems | **Very high**: customer billed twice, tax correction, reputational damage | **1** |
| R2 | Business errors are retried, or technical errors are given up too early | Medium | High: wasted ERP load, or billing silently lost | 2 |
| R3 | The requester never receives the result, or cannot parse it | Medium | High: operation stuck waiting, manual follow-up | 2 |
| R4 | A malformed request reaches the ERP | Low to medium | Medium: wrong documents, data cleanup | 3 |
| R5 | The ERP test double behaves differently from what the worker expects | Low | Medium: green tests for the wrong reason | 3 |

## 3. Failure-point matrix (R1)

Where can the worker stop, and what prevents a duplicate when the message comes back?

| Failure point | Safeguard | Test (protection) | Negative control (safeguard off) |
|---|---|---|---|
| Source sends the same request twice | Broker duplicate detection + idempotency store | Resent requests (3 tests) | 2 invoices |
| Crash after the sales order commit, before the checkpoint | Reconciliation by reference | Crash after the sales order | 2 sales orders |
| Crash after the delivery commit | Reconciliation | Crash after the delivery | — |
| Crash after the invoice commit | Reconciliation | Crash after the invoice | — |
| ERP commits but answers after the client timeout | Reconciliation | Timeout after commit (order, invoice) | 2 invoices |
| Crash after the callback, before completing the message | Idempotency store (`COMPLETED`) | Crash after callback | 2 invoices |
| ERP call longer than the message lock | Lock renewal | Slow ERP call | 2 invoices, `LOCK_LOST` |
| Two requests for the same customer at once | Broker sessions | Same-customer requests | Overlapping processing |
| Dead-lettered halfway, resubmitted later | `FAILED` record + reconciliation | Resubmission after technical failure | — |

## 4. State transitions of the idempotency record

| From | Event | To | Worker behavior |
|---|---|---|---|
| (none) | Message received | `IN_PROGRESS` | Run all steps |
| `IN_PROGRESS` | Redelivered (crash, timeout, lock expired) | `IN_PROGRESS` | **Reconcile with the ERP first**, run only missing steps |
| `IN_PROGRESS` | All steps done, or business error | `COMPLETED` | Store the result, send the callback |
| `IN_PROGRESS` | Technical error on the last attempt | `FAILED` | Dead-letter, send `TECHNICAL_ERROR` |
| `FAILED` | Resubmitted | `IN_PROGRESS` | Reconcile, resume |
| `COMPLETED` | Received again | `COMPLETED` | **Never call the ERP.** Resend the stored result |

A business error is final for its key: the requester must fix the data and send a **new** key.

## 5. Error classification (R2)

| Source | Classification | Retried? | Result |
|---|---|---|---|
| ERP `422` (blocked customer, credit limit, unknown SKU) | Business | No | `BUSINESS_ERROR` on the first delivery |
| ERP `5xx`, timeout, unreachable | Technical | Yes, up to `maxDeliveryCount` | `RETRY` → `DEAD_LETTERED` + `TECHNICAL_ERROR` |
| Callback endpoint down | Technical (delivery) | Yes, only the callback is resent | Result kept `COMPLETED`, the ERP is not called again |
| Invalid envelope | Contract | No | Dead-lettered before any ERP call, `INVALID_ENVELOPE` when the requester can be answered |

## 6. Test design for the request contract (R4)

| Field | Valid partitions | Invalid partitions | Boundaries |
|---|---|---|---|
| `operation` | `STANDARD_INVOICE`, `SERVICE_INVOICE` | anything else | — |
| `contractVersion` | `1.0` | other versions | — |
| `payload.items` | 1 to 50 items | empty, more than 50 | 0 / 1 / 50 / 51 |
| `quantity` | integer 1 to 9999 | 0, decimals, above 9999 | 0 / 1 / 9999 / 10000 |
| `idempotencyKey` | 8 to 64 chars `[A-Za-z0-9-]` | shorter, longer | 7 / 8 / 64 / 65 |
| Envelope vs. broker metadata | `idempotencyKey = messageId`, `customerId = sessionId` | mismatch | — |

## 7. Entry and exit criteria

- **Entry:** dependencies installed, Node.js 22 or later.
- **Exit:** 100% of the tests pass, line coverage ≥ 95% and branch coverage ≥ 85%
  (enforced in CI), and every negative-control test still detects its duplicate.

## 8. Known limitations

- The queue is an in-memory model. It reproduces the broker semantics the worker depends on,
  not a specific vendor's edge cases.
- If the ERP already holds two orders with the same reference (created before these safeguards existed),
  reconciliation uses the first one. In production this case should go to manual review.
- The callback is **at-least-once**: the requester may receive the same result more than once and must
  deduplicate by `idempotencyKey`. The tests check that repeated callbacks are identical.
