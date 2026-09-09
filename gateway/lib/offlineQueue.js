'use strict';

/**
 * Durable, order-preserving offline CDR queue.
 *
 * Many deployment sites see grid instability and intermittent connectivity. A
 * Charge Detail Record must never be lost if the peer, the payment rail, or the
 * internet is momentarily unreachable. CDRs are appended to a disk-backed queue
 * and flushed in FIFO order; a failed item stays at the head so nothing is
 * dropped or reordered, preserving transactional integrity across reconnects.
 */

const fs = require('fs');
const path = require('path');

class OfflineQueue {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.logger = logger || (() => {});
    this.items = [];
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.items = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.logger(`offline queue restored: ${this.items.length} pending CDR(s)`);
      }
    } catch (e) {
      this.logger(`offline queue load failed, starting empty: ${e.message}`);
      this.items = [];
    }
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.items, null, 2));
  }

  enqueue(item) {
    this.items.push(item);
    this._persist();
    this.logger(`CDR ${item.cdr_id} enqueued (depth=${this.items.length})`);
  }

  size() {
    return this.items.length;
  }

  /**
   * Attempt to flush the queue in FIFO order. `handler(item)` must resolve on
   * success. On the first failure we stop and keep the remaining items (head
   * preserved) so ordering and at-least-once delivery are guaranteed.
   */
  async flush(handler) {
    let flushed = 0;
    while (this.items.length > 0) {
      const item = this.items[0];
      try {
        await handler(item);
        this.items.shift();
        this._persist();
        flushed += 1;
      } catch (e) {
        this.logger(`flush halted at CDR ${item.cdr_id} (kept for retry): ${e.message}`);
        break;
      }
    }
    if (flushed > 0) this.logger(`offline queue flushed ${flushed} CDR(s); depth now ${this.items.length}`);
    return flushed;
  }
}

module.exports = { OfflineQueue };
