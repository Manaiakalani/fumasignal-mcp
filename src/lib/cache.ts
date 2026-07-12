/** Trivial in-memory TTL cache with a soft entry-count cap and an optional total-size budget. */

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
