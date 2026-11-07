'use strict';

class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Memeriksa apakah kunci (user:scope) sedang terkena cooldown.
   * @returns {{ limited: boolean, retryAfterMs: number }}
   */
  check(key, cooldownMs) {
    if (!cooldownMs || cooldownMs <= 0) {
      return { limited: false, retryAfterMs: 0 };
    }

    const now = Date.now();
    const expiresAt = this.buckets.get(key) || 0;
    if (expiresAt > now) {
      return {
        limited: true,
        retryAfterMs: expiresAt - now
      };
    }

    this.buckets.set(key, now + cooldownMs);
    return { limited: false, retryAfterMs: 0 };
  }

  cleanup() {
    const now = Date.now();
    for (const [key, expiresAt] of this.buckets.entries()) {
      if (expiresAt <= now) {
        this.buckets.delete(key);
      }
    }
  }

  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buckets.clear();
  }
}

module.exports = {
  RateLimiter,
  globalRateLimiter: new RateLimiter()
};
