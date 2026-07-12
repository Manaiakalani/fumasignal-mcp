import { describe, it, expect } from 'vitest';
import { extractToc, extractSection, slugify } from '../src/lib/markdown.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('  Trim Me  ')).toBe('trim-me');
    expect(slugify('Special!@# chars')).toBe('special-chars');
  });

  it('preserves non-ASCII letters instead of stripping them', () => {
    // Regression: the old regex was ASCII-only ([^a-z0-9\s-]) and silently
    // dropped every accented/CJK/etc. character, which could collapse
    // distinct headings (e.g. "Café" and "Cafe") to the same anchor.
    expect(slugify('Café Déjà Vu')).toBe('café-déjà-vu');
    expect(slugify('日本語 Docs')).toBe('日本語-docs');
  });
});

describe('extractToc', () => {
  it('returns headings in order with depths and anchors', () => {
    const md = `# Top\nintro\n## Sub A\nx\n### Deep\ny\n## Sub B\nz`;
    expect(extractToc(md)).toEqual([
      { depth: 1, title: 'Top', anchor: 'top' },
      { depth: 2, title: 'Sub A', anchor: 'sub-a' },
      { depth: 3, title: 'Deep', anchor: 'deep' },
      { depth: 2, title: 'Sub B', anchor: 'sub-b' },
    ]);
  });

  it('disambiguates duplicate headings', () => {
    const md = `## Setup\nfirst\n## Setup\nsecond`;
    const toc = extractToc(md);
    expect(toc.map((t) => t.anchor)).toEqual(['setup', 'setup-1']);
  });

  it('ignores headings inside fenced code blocks', () => {
    const md = '# Real\n\n```\n# Not a heading\n```\n\n## Also Real';
    expect(extractToc(md).map((t) => t.title)).toEqual(['Real', 'Also Real']);
  });

  it('strips an optional closing "#" sequence and surrounding whitespace', () => {
    const md = '## Setup ##\n\n### Trailing Space  \n\n#### Mixed ## \t ';
    expect(extractToc(md).map((t) => t.title)).toEqual([
      'Setup',
      'Trailing Space',
      'Mixed',
    ]);
  });

  it('does not hang on a large adversarial heading line (ReDoS regression)', () => {
    // Regression: the old HEADING_RE (`/^(#{1,6})\s+(.+?)\s*#*\s*$/`) put a
    // lazy group directly before three quantifiers that can all match the
    // same trailing characters, so a line with no valid closing sequence
    // forced catastrophic backtracking - empirically ~36s for a 5KB line,
    // >120s for 10KB. A large adversarial line must resolve near-instantly.
    const adversarial = '# a' + ' '.repeat(200 * 1024) + '!';
    const start = Date.now();
    const toc = extractToc(adversarial);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(toc).toHaveLength(1);
    expect(toc[0]!.title.endsWith('!')).toBe(true);
  });
});

describe('extractSection', () => {
  const md = `# Top\n\nintro text\n\n## Setup\n\nsetup body\n\n### Sub\n\nsub body\n\n## Other\n\nother body`;

  it('extracts a section up to the next equal-or-lesser heading', () => {
    const section = extractSection(md, 'setup');
    expect(section?.title).toBe('Setup');
    expect(section?.markdown).toContain('setup body');
    expect(section?.markdown).toContain('### Sub');
    expect(section?.markdown).toContain('sub body');
    expect(section?.markdown).not.toContain('## Other');
  });

  it('returns null for unknown anchors', () => {
    expect(extractSection(md, 'nope')).toBeNull();
  });

  it('handles duplicate-heading anchors with -N suffix', () => {
    const dup = `## Foo\nfirst\n## Foo\nsecond`;
    expect(extractSection(dup, 'foo')?.markdown).toContain('first');
    expect(extractSection(dup, 'foo-1')?.markdown).toContain('second');
  });

  it('stays consistent with extractToc when duplicate titles appear at different depths', () => {
    // Regression: extractToc's dedup counter was depth-independent while
    // extractSection recomputed occurrence counts per-depth, so a heading
    // that extractToc listed as e.g. "foo-1" could not be found by
    // extractSection (it would return null for an anchor the TOC itself
    // advertised).
    const md = `# Foo\ntextA\n## Foo\ntextB\n`;
    const toc = extractToc(md);
    expect(toc.map((t) => t.anchor)).toEqual(['foo', 'foo-1']);
    expect(extractSection(md, 'foo')?.markdown).toContain('textA');
    expect(extractSection(md, 'foo-1')?.markdown).toContain('textB');
  });
});
