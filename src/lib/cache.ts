/**
 * In-memory caching/concurrency helpers: a TTL cache with a soft
 * entry-count cap and optional total-size budget, plus two small
 * concurrency primitives (`Coalescer`, `Semaphore`) used to bound how much
 * outstanding fetch work a source can have in flight at once.
 */

/**
 * De-duplicates concurrent async work by key: while a `run()` call for a
 * given key is in flight, any other `run()` call for that *same* key
 * shares the same promise instead of independently repeating the work.
 *
 * Without this, N concurrent cache-miss requests for the same not-yet-cached
 * key (e.g. `getPage()` called twice in parallel for a page nobody has
 * fetched yet) each start their own independent fetch chain - multiplying
 * network requests and buffered-response memory by N, and defeating a
 * per-response byte cap's purpose as an aggregate resource bound. Coalescing
 * collapses that to exactly one fetch chain regardless of how many
 * concurrent callers are waiting on it.
 */
export class Coalescer<K, V> {
  private pending = new Map<K, Promise<V>>();

  async run(key: K, fn: () => Promise<V>): Promise<V> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = fn().finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }
}

/**
 * Bounds how many `run()` callbacks can be executing at once; calls beyond
 * that limit queue (FIFO) until a slot frees up. Complements `Coalescer`,
 * which only de-dupes *identical* keys - it does nothing for N concurrent
 * requests that all have *distinct* keys (e.g. `getPage()` called in
 * parallel for many different pages, or `search()` with many different
 * queries), so each of those still starts its own independent fetch. Since
 * an individual response can buffer up to `maxResponseBytes`, unbounded
 * concurrent distinct fetches means aggregate buffered memory scales with
 * however many distinct requests a caller decides to issue at once, with
 * nothing in this file capping it. A semaphore bounds that directly,
 * regardless of how many distinct keys are involved.
 *
 * The *active* slot count above is bounded by construction, but callers
 * that lose the race for a slot wait in `queue` instead - and that queue
 * has its own unbounded-growth risk: a caller issuing many concurrent
 * `run()` calls for distinct keys (e.g. one MCP tool call per call, each
 * with its own ref/query) queues one closure per call beyond the active
 * cap, with nothing bounding how many can pile up. `maxQueueLength`
 * closes that the same way every other budget in this file is enforced -
 * reject once the limit is hit rather than let the backlog grow
 * unboundedly - instead of only bounding how much work runs at once.
 */
export class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];
  private readonly maxQueueLength: number;

  constructor(maxConcurrent: number, maxQueueLength = 1000) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError(
        `Semaphore: maxConcurrent must be a positive integer, got ${maxConcurrent}`,
      );
    }
    if (!Number.isInteger(maxQueueLength) || maxQueueLength < 0) {
      throw new RangeError(
        `Semaphore: maxQueueLength must be a non-negative integer, got ${maxQueueLength}`,
      );
    }
    this.available = maxConcurrent;
    this.maxQueueLength = maxQueueLength;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueueLength) {
      return Promise.reject(
        new Error(
          `Semaphore: queue limit (${this.maxQueueLength}) exceeded - too many callers waiting for a slot`,
        ),
      );
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.available--;
        resolve();
      });
    });
  }

  private release(): void {
    this.available++;
    // Hand the freed slot straight to the next waiter (if any) rather than
    // just incrementing the counter and letting them re-check it - avoids a
    // starvation/fairness gap where a brand-new `acquire()` call racing a
    // long-queued waiter could grab the slot first.
    const next = this.queue.shift();
    if (next) next();
  }
}

interface Entry<V> {
  value: V;
  expiresAt: number;
  size: number;
}

export interface TtlCacheByteOptions<V> {
  /**
   * Soft cap on the *combined* `sizeOf`-reported size of every cached
   * value. Unbounded (Infinity) by default. A per-entry size limit
   * upstream (e.g. a response-byte cap) isn't sufficient on its own to
   * bound aggregate memory: `maxEntries` distinct large values can still
   * accumulate to `maxEntries * perEntryCap` before this is set.
   */
  maxTotalSize?: number;
  /** Reports the "size" of a value for `maxTotalSize` accounting. Default: always 0 (byte budget disabled). */
  sizeOf?: (value: V) => number;
}

export class TtlCache<K, V> {
  private store = new Map<K, Entry<V>>();
  private maxTotalSize: number;
  private sizeOf: (value: V) => number;
  private totalSize = 0;

  constructor(
    private ttlMs: number,
    private maxEntries = 500,
    byteOptions: TtlCacheByteOptions<V> = {},
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new RangeError(`TtlCache: ttlMs must be a non-negative finite number, got ${ttlMs}`);
    }
    this.maxTotalSize = byteOptions.maxTotalSize ?? Infinity;
    this.sizeOf = byteOptions.sizeOf ?? (() => 0);
  }

  get(key: K): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.totalSize -= hit.size;
      return undefined;
    }
    // Move to the end of the Map's iteration order so `set()` evicts the
    // least-recently-used entry rather than the least-recently-inserted one.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: K, value: V): void {
    const existing = this.store.get(key);
    if (existing) {
      this.totalSize -= existing.size;
      this.store.delete(key);
    }
    const size = this.sizeOf(value);
    // Evict least-recently-used entries until both the entry-count and
    // (if configured) total-size budgets have room for the incoming entry.
    // A single entry larger than the whole budget is still let through
    // once the store is empty, rather than rejected outright - it just
    // won't accumulate alongside others.
    while (
      this.store.size > 0 &&
      (this.store.size >= this.maxEntries || this.totalSize + size > this.maxTotalSize)
    ) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.store.get(oldestKey);
      this.store.delete(oldestKey);
      if (oldest) this.totalSize -= oldest.size;
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs, size });
    this.totalSize += size;
  }

  clear(): void {
    this.store.clear();
    this.totalSize = 0;
  }
}
