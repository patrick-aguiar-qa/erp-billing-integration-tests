'use strict';

const { randomUUID } = require('node:crypto');

class LockLostError extends Error {
  constructor(message = 'The message lock was lost (expired or taken by another consumer)') {
    super(message);
    this.name = 'LockLostError';
  }
}

/**
 * In-memory stand-in for a cloud message broker queue used in peek-lock mode.
 *
 * It models the broker features the billing worker relies on:
 * - duplicate detection by messageId inside a time window;
 * - sessions: messages of the same session are delivered in order and to one consumer at a time;
 * - peek-lock: a received message stays in the queue, locked, until it is completed;
 *   if the lock expires the message becomes visible again (redelivery);
 * - delivery count and a dead-letter queue.
 */
class InMemoryQueue {
  constructor({
    lockDurationMs = 1000,
    maxDeliveryCount = 3,
    duplicateDetection = true,
    duplicateWindowMs = 10 * 60 * 1000,
    sessions = true,
  } = {}) {
    Object.assign(this, { lockDurationMs, maxDeliveryCount, duplicateDetection, duplicateWindowMs, sessions });
    this.messages = [];
    this.deadLetters = [];
    this.seenMessageIds = new Map();
  }

  send({ messageId, sessionId = null, body }) {
    if (!messageId) throw new Error('messageId is required');
    const now = Date.now();

    if (this.duplicateDetection) {
      const seenAt = this.seenMessageIds.get(messageId);
      if (seenAt !== undefined && now - seenAt < this.duplicateWindowMs) {
        return { accepted: false, reason: 'DUPLICATE_MESSAGE_ID' };
      }
      this.seenMessageIds.set(messageId, now);
    }

    this.messages.push({
      messageId,
      sessionId,
      body: structuredClone(body),
      deliveryCount: 0,
      lockToken: null,
      lockedUntil: 0,
    });
    return { accepted: true };
  }

  /** Returns the next available message (locked for this consumer) or null. */
  receive() {
    const now = Date.now();
    const busySessions = new Set();
    const headSeen = new Set();

    if (this.sessions) {
      for (const m of this.messages) {
        if (m.sessionId !== null && this.#isLocked(m, now)) busySessions.add(m.sessionId);
      }
    }

    for (const m of this.messages) {
      if (this.sessions && m.sessionId !== null) {
        if (busySessions.has(m.sessionId) || headSeen.has(m.sessionId)) continue;
        headSeen.add(m.sessionId); // FIFO inside a session: only its first message is eligible
      }
      if (this.#isLocked(m, now)) continue;

      if (m.deliveryCount >= this.maxDeliveryCount) {
        this.#moveToDeadLetter(m, 'MAX_DELIVERY_COUNT_EXCEEDED');
        return this.receive();
      }

      m.deliveryCount += 1;
      m.lockToken = randomUUID();
      m.lockedUntil = now + this.lockDurationMs;
      return {
        messageId: m.messageId,
        sessionId: m.sessionId,
        body: structuredClone(m.body),
        deliveryCount: m.deliveryCount,
        lockToken: m.lockToken,
      };
    }
    return null;
  }

  /** Removes the message: processing finished. */
  complete(lockToken) {
    const m = this.#lockedMessage(lockToken);
    this.messages.splice(this.messages.indexOf(m), 1);
  }

  /** Releases the lock: the message becomes available again right away. */
  abandon(lockToken) {
    const m = this.#lockedMessage(lockToken);
    m.lockToken = null;
    m.lockedUntil = 0;
  }

  deadLetter(lockToken, reason) {
    this.#moveToDeadLetter(this.#lockedMessage(lockToken), reason);
  }

  /** Extends the lock so a long-running consumer keeps ownership of the message. */
  renewLock(lockToken) {
    this.#lockedMessage(lockToken).lockedUntil = Date.now() + this.lockDurationMs;
  }

  get activeCount() {
    return this.messages.length;
  }

  #lockedMessage(lockToken) {
    const m = this.messages.find((candidate) => candidate.lockToken === lockToken);
    if (!m || !this.#isLocked(m, Date.now())) throw new LockLostError();
    return m;
  }

  #isLocked(m, now) {
    return m.lockToken !== null && m.lockedUntil > now;
  }

  #moveToDeadLetter(m, reason) {
    this.messages.splice(this.messages.indexOf(m), 1);
    this.deadLetters.push({
      messageId: m.messageId,
      sessionId: m.sessionId,
      body: m.body,
      deliveryCount: m.deliveryCount,
      reason,
    });
  }
}

module.exports = { InMemoryQueue, LockLostError };
