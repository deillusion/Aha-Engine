import { setTimeout as delay } from 'node:timers/promises';
// Per-model scheduling only changes transport timing. All seats still read the
// same frozen round input, and request parameters remain fixed across retries.
export class ModelGate {
  constructor(limit = 32, intervalMs = 0) { this.limit = limit; this.intervalMs = intervalMs; this.active = 0; this.waiters = []; this.nextStart = 0; }
  reserve(signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      waiter.abort = () => { this.waiters = this.waiters.filter(w => w !== waiter); reject(signal.reason); };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter); this.drain();
    });
  }
  drain() {
    while (this.active < this.limit && this.waiters.length) {
      const waiter = this.waiters.shift(); waiter.signal?.removeEventListener('abort', waiter.abort);
      if (waiter.signal?.aborted) { waiter.reject(waiter.signal.reason); continue; }
      this.active++; let released = false;
      waiter.resolve(() => { if (!released) { released = true; this.active--; this.drain(); } });
    }
  }
  async acquire(signal) {
    const release = await this.reserve(signal);
    try {
      const waitMs = Math.max(0, this.nextStart - Date.now());
      this.nextStart = Date.now() + waitMs + this.intervalMs;
      if (waitMs) await delay(waitMs, undefined, { signal });
      signal?.throwIfAborted(); return release;
    } catch (e) { release(); throw e; }
  }
}
