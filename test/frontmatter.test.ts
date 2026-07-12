import { describe, it, expect } from 'vitest';
import { parseFrontmatter, sanitizeParsedYaml } from '../src/lib/frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses ordinary YAML front matter', () => {
    const raw = `---\ntitle: Hello World\ntags: [a, b, c]\ncount: 42\npublished: true\n---\nbody`;
    const { content, data } = parseFrontmatter(raw);
    expect(content.trim()).toBe('body');
    expect(data.title).toBe('Hello World');
    expect(data.tags).toEqual(['a', 'b', 'c']);
    expect(data.count).toBe(42);
    expect(data.published).toBe(true);
  });

  it('preserves Date values from YAML timestamp scalars', () => {
    const raw = `---\ndate: 2024-01-15\n---\nbody`;
    const { data } = parseFrontmatter(raw);
    expect(data.date).toBeInstanceOf(Date);
    expect((data.date as Date).toISOString().slice(0, 10)).toBe('2024-01-15');
  });

  it('preserves nested objects and arrays unchanged', () => {
    const raw = `---\nnested:\n  x: 1\n  y: [1, 2, 3]\n---\nbody`;
    const { data } = parseFrontmatter(raw);
    expect(data.nested).toEqual({ x: 1, y: [1, 2, 3] });
  });

  it('disables the javascript front matter engine', () => {
    const raw = `---javascript\nmodule.exports = { pwned: true }\n---\nbody`;
    expect(() => parseFrontmatter(raw)).toThrow(/disabled/);
  });

  it('bounds a YAML "billion laughs" anchor/alias bomb to a small, fast output', () => {
    // 9 levels of 9-wide array aliasing: ~413 bytes of YAML that, without
    // a sanitizer, JSON.stringify's to ~469MB (a ~1,100,000x
    // amplification) in ~1.1s, without ever throwing (unlike a true
    // cycle, which JSON.stringify itself rejects).
    const lines = ['a0: &a0 [lol,lol,lol,lol,lol,lol,lol,lol,lol]'];
    for (let i = 1; i < 9; i++) {
      const prev = `*a${i - 1}`;
      lines.push(`a${i}: &a${i} [${Array(9).fill(prev).join(',')}]`);
    }
    const raw = `---\n${lines.join('\n')}\n---\ncontent`;

    const start = Date.now();
    const { data } = parseFrontmatter(raw);
    const json = JSON.stringify(data);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(json.length).toBeLessThan(1_000_000);
  });

  it('replaces a genuine self-referential YAML anchor cycle instead of stack-overflowing', () => {
    const raw = `---\na: &a\n  b: *a\n---\ncontent`;
    const { data } = parseFrontmatter(raw);
    expect(() => JSON.stringify(data)).not.toThrow();
    expect(JSON.stringify(data)).toContain('circular reference');
  });

  it('truncates one enormous string leaf', () => {
    const huge = 'x'.repeat(5_000_000);
    const raw = `---\ntitle: "${huge}"\n---\ncontent`;
    const { data } = parseFrontmatter(raw);
    expect((data.title as string).length).toBeLessThan(huge.length);
  });

  it('does not let a "__proto__" frontmatter key hijack the sanitized object\'s prototype', () => {
    // Regression: `out[k] = sanitizeNode(...)` on a plain `{}` object
    // invokes Object.prototype's `__proto__` accessor setter when
    // `k === '__proto__'`, *replacing* the output object's own prototype
    // with the attacker's value instead of storing it as an ordinary data
    // property. That lets unset fields silently "shadow"-resolve through
    // the hijacked prototype chain (e.g. `data.locale`/`data.tag`) without
    // ever appearing in Object.keys()/JSON.stringify() - a confused-deputy
    // risk for any code that reads frontmatter fields via dot access.
    const raw = `---
__proto__:
  title: "INJECTED"
  polluted: true
title: "legit title"
---
content`;
    const { data } = parseFrontmatter(raw);
    expect(data.title).toBe('legit title');
    expect((data as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.keys(data)).toContain('__proto__');
    // The unrelated process-wide Object.prototype must be untouched too.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('sanitizeParsedYaml', () => {
  it('is a no-op for small, ordinary data', () => {
    const input = { a: 1, b: 'x', c: [1, 2, 3], d: { e: 'f' } };
    expect(sanitizeParsedYaml(input)).toEqual(input);
  });

  it("charges a long object key's own length against the budget, not just its value", () => {
    // Regression: the sanitization loop only ever charged the budget via
    // the recursive call on each entry's *value* - the key string itself
    // was used directly (via defineOwn) and never subtracted from
    // budget.remaining anywhere. A single mapping entry with an extremely
    // long key and a short value would consume almost none of the
    // 200,000-unit budget while still contributing its full length to the
    // eventual JSON-serialized size, defeating the budget's purpose for
    // that shape of input. A 250,000-character key alone now exceeds the
    // entire budget, so the entry is truncated just like any other
    // budget-exhausting content.
    const longKey = 'k'.repeat(250_000);
    const input = { [longKey]: 'short value', other: 'ok' };
    const sanitized = sanitizeParsedYaml(input);
    expect(JSON.stringify(sanitized).length).toBeLessThan(1000);
    expect(Object.keys(sanitized)).not.toContain(longKey);
  });

  it('still allows many ordinary, reasonably-sized keys through untouched', () => {
    // Sanity check that the new per-key charge doesn't affect normal
    // front matter - a realistic tag list or metadata object with dozens
    // of short keys shouldn't come remotely close to the budget.
    const input: Record<string, string> = {};
    for (let i = 0; i < 50; i++) input[`field_${i}`] = `value ${i}`;
    expect(sanitizeParsedYaml(input)).toEqual(input);
  });
});
