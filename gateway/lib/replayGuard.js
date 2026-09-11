'use strict';

/**
 * Handshake freshness / replay guard.
 *
 * A signature proves the sender holds the messaging key. On its own it does NOT
 * prove they hold it *now* — anyone who captures a valid signed handshake (a
 * proxy log, a mirrored port, a stored request) could re-send those exact bytes
 * forever and be accepted every time.
 *
 * Two checks close that:
 *   1. FRESHNESS — the signed timestamp must be within a narrow window, so a
 *      captured request expires quickly.
 *   2. SINGLE USE — the signed nonce must not have been seen before, so a
 *      request cannot be replayed even inside its own window.
 *
 * Because check 1 bounds how long a nonce can matter, the seen-nonce set only
 * ever has to remember one window's worth of traffic; anything older is pruned.
 * Memory is therefore bounded by handshake rate, not by uptime.
 *
 * Scope note: this is per-process, in-memory state. An operator running several
 * gateway replicas behind a load balancer would back it with a shared store
 * (Redis or equivalent) so a replay cannot simply be aimed at a second replica.
 * The PoC runs one process per gateway, so a local set is sufficient and honest.
 */

/** How far a handshake timestamp may be from our clock, in either direction. */
const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes, absorbing modest clock skew

class ReplayGuard {
  constructor({ windowMs = DEFAULT_WINDOW_MS, logger } = {}) {
    this.windowMs = windowMs;
    this.logger = logger || (() => {});
    this.seen = new Map(); // nonce -> expiry epoch ms
  }

  _prune(now) {
    for (const [nonce, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(nonce);
    }
  }

  /**
   * Validate a handshake's freshness and single-use nonce, consuming the nonce
   * on success.
   *
   * @returns {{ok: true}} or {{ok: false, reason: string}} — the caller decides
   *          the HTTP status and logs the rejection.
   */
  check({ timestamp, nonce }, now = Date.now()) {
    if (!timestamp || !nonce) {
      return { ok: false, reason: 'missing handshake timestamp or nonce' };
    }

    const signedAt = Date.parse(timestamp);
    if (!Number.isFinite(signedAt)) {
      return { ok: false, reason: 'handshake timestamp is not a valid ISO-8601 instant' };
    }

    const skew = now - signedAt;
    if (Math.abs(skew) > this.windowMs) {
      const dir = skew > 0 ? 'old' : 'in the future';
      return {
        ok: false,
        reason: `handshake timestamp is stale: ${Math.round(Math.abs(skew) / 1000)}s ${dir} ` +
          `(window ±${Math.round(this.windowMs / 1000)}s)`,
      };
    }

    this._prune(now);
    if (this.seen.has(nonce)) {
      return { ok: false, reason: `handshake nonce already used (replay): ${nonce}` };
    }

    // Hold the nonce for a full window past the signed time: until then, a
    // replay of these same bytes would still pass the freshness check.
    this.seen.set(nonce, signedAt + this.windowMs);
    return { ok: true };
  }

  size() {
    return this.seen.size;
  }
}

module.exports = { ReplayGuard, DEFAULT_WINDOW_MS };
