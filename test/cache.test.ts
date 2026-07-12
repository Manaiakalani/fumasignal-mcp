import { describe, it, expect, vi, afterEach } from 'vitest';
import { TtlCache } from '../src/lib/cache.js';

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

  it('clear() empties the cache', () => {
    const cache = new TtlCache<string, number>(1000);
    cache.set('a', 1);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });
});
