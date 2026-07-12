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
});

describe('sanitizeParsedYaml', () => {
  it('is a no-op for small, ordinary data', () => {
    const input = { a: 1, b: 'x', c: [1, 2, 3], d: { e: 'f' } };
    expect(sanitizeParsedYaml(input)).toEqual(input);
  });
});
