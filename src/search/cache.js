'use strict';

/**
 * A small time-to-live LRU cache.
 *
 * Search results go stale quickly, but the same query is often issued twice
 * (autocomplete → result page, or a page reload), so a short-lived cache
 * removes a lot of redundant network traffic.
 */

class LRUCache {
  constructor({ max = 200, ttl = 5 * 60 * 1000 } = {}) {
    this.max = max;
    this.ttl = ttl;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttl = this.ttl) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttl });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }

  /** Drop expired entries so memory does not creep up on long sessions. */
  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now > entry.expires) this.map.delete(key);
    }
  }
}

module.exports = { LRUCache };
