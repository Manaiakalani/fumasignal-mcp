import { describe, it, expect, vi, afterEach } from 'vitest';
import { TtlCache, Semaphore } from '../src/lib/cache.js';

describe('TtlCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for missing keys and stores/retrieves values', () => {
    const cache = new TtlCache<string, number>(1000);
    expect(cache.get('a')).toBeUndefined();
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('expires entries after ttlMs elapses', () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string, number>(1000);
    cache.set('a', 1);
    vi.advanceTimersByTime(1001);
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the oldest entry once over capacity', () => {
    const cache = new TtlCache<string, number>(100_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // over capacity -> evicts 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('touching an entry via get() protects it from LRU eviction', () => {
    // Regression: get() used to leave the Map's insertion order untouched,
    // so a just-read "hot" entry could still be the next one evicted
    // simply because it happened to be inserted first.
    const cache = new TtlCache<string, number>(100_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // touch 'a' -> 'b' becomes the least-recently-used
    cache.set('c', 3); // over capacity -> should evict 'b', not 'a'
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('re-setting an existing key refreshes its recency', () => {
    const cache = new TtlCache<string, number>(100_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10); // refresh 'a' -> 'b' becomes least-recently-used
    cache.set('c', 3); // over capacity -> should evict 'b'
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('rejects a non-finite or negative ttlMs at construction time', () => {
    expect(() => new TtlCache(-1)).toThrow(RangeError);
    expect(() => new TtlCache(Number.NaN)).toThrow(RangeError);
    expect(() => new TtlCache(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('accepts a ttlMs of 0 (immediate expiry)', () => {
    expect(() => new TtlCache(0)).not.toThrow();
  });

  it('a ttlMs of 0 actually expires immediately, not just on construction', () => {
    // Regression: `hit.expiresAt < Date.now()` (strict less-than) meant a
    // ttlMs=0 entry read back in the *same* millisecond as it was set was
    // still treated as fresh, contradicting "immediate expiry". Fake
    // timers pin Date.now() so get() runs at the exact same instant as
    // set() deterministically, exercising the boundary without relying on
    // real-clock timing luck.
    vi.useFakeTimers();
    const cache = new TtlCache<string, number>(0);
    cache.set('a', 1);
    expect(cache.get('a')).toBeUndefined();
  });

  it('supports a total-size budget that evicts LRU entries regardless of entry count', () => {
    // Regression: maxEntries alone still allows maxEntries * (per-entry
    // size) to accumulate. A byte-budget-aware cache (used for
    // RemoteFumadocsSource's pageCache) must evict once the *combined*
    // size of cached values would exceed the budget, even with room left
    // under maxEntries.
    const cache = new TtlCache<string, string>(100_000, 500, {
      maxTotalSize: 25,
      sizeOf: (v) => v.length,
    });
    cache.set('a', 'x'.repeat(10)); // total 10
    cache.set('b', 'x'.repeat(10)); // total 20
    cache.set('c', 'x'.repeat(10)); // would be 30 > 25 -> evicts 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('x'.repeat(10));
    expect(cache.get('c')).toBe('x'.repeat(10));
  });

  it('lets a single oversized entry through without rejecting it, but does not let it accumulate', () => {
    const cache = new TtlCache<string, string>(100_000, 500, {
      maxTotalSize: 10,
      sizeOf: (v) => v.length,
    });
    cache.set('a', 'x'.repeat(50)); // over budget alone, but store was empty
    expect(cache.get('a')).toBe('x'.repeat(50));
    cache.set('b', 'x'.repeat(50)); // 'a' must be evicted to make room
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('x'.repeat(50));
  });

  it('clear() resets the total-size accounting too', () => {
    const cache = new TtlCache<string, string>(100_000, 500, {
      maxTotalSize: 10,
      sizeOf: (v) => v.length,
    });
    cache.set('a', 'x'.repeat(10));
    cache.clear();
    cache.set('b', 'x'.repeat(10)); // would wrongly evict immediately if totalSize wasn't reset
    expect(cache.get('b')).toBe('x'.repeat(10));
  });

  it('clear() empties the cache', () => {
    const cache = new TtlCache<string, number>(1000);
    cache.set('a', 1);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('Semaphore', () => {
  it('rejects a non-positive or non-integer maxConcurrent at construction time', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(-1)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
  });

  it('never lets more than maxConcurrent callbacks run at once', async () => {
    // Regression target: without this, N concurrent calls with N distinct
    // keys (nothing for a Coalescer to de-dupe) would all run unbounded.
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const track = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return 'done';
    };
    const results = await Promise.all([
      sem.run(track),
      sem.run(track),
      sem.run(track),
      sem.run(track),
      sem.run(track),
    ]);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('releases the slot even when the callback throws, so later callers are not starved', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // If the slot leaked, this would hang forever - vitest's default
    // per-test timeout turns that into a failure rather than a false pass.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('queues excess callers and lets them proceed one at a time as slots free up', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const makeTask = (id: number) => async () => {
      order.push(id);
      await new Promise((r) => setTimeout(r, 5));
      return id;
    };
    const results = await Promise.all([
      sem.run(makeTask(1)),
      sem.run(makeTask(2)),
      sem.run(makeTask(3)),
    ]);
    // With maxConcurrent=1, callbacks must start in the same order they
    // called run() - if the semaphore let a later caller "jump ahead", the
    // push order (recorded when each callback actually *starts*) would differ.
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
  });
});
