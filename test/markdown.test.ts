import { describe, it, expect } from 'vitest';
import {
  extractToc,
  extractSection,
  slugify,
  buildHeadingIndex,
  tocFromHeadingIndex,
  sectionFromHeadingIndex,
} from '../src/lib/markdown.js';

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

  it('caps the number of headings collected from a single document', () => {
    // Regression: collectHeadings() had no cap at all - a file of many
    // one-line "# x" headings (4 bytes each; well within any per-file
    // byte limit) could produce headings/anchors/TOC entries numbering in
    // the millions, each retained in memory indefinitely once indexed
    // (local.ts/remote.ts hold every page's toc for the process's
    // lifetime). 10,000 tiny headings - comfortably beyond any real
    // documentation page - must be bounded to a small, fixed cap rather
    // than producing 10,000 TOC entries.
    const md = Array.from({ length: 10_000 }, (_, i) => `# Heading ${i}`).join('\n');
    const toc = extractToc(md);
    expect(toc.length).toBeLessThanOrEqual(5000);
    expect(toc.length).toBeGreaterThan(0);
    expect(toc[0]!.title).toBe('Heading 0');
  });

  it('caps the number of lines retained for a single document, independent of heading count (memory regression)', () => {
    // Regression: collectHeadings() split the whole document into a
    // `lines` array with no bound of its own - MAX_HEADINGS only limits
    // *headings found*, not lines scanned/retained, so a file with few
    // or no headings never triggered it. A newline-heavy file well
    // within any per-file byte cap (e.g. 10MB of pure newlines - ~5M
    // lines) split into millions of array entries that were then
    // retained for the process's lifetime as part of the cached
    // HeadingIndex, adding ~85MB of heap for a single such page.
    // Line count must now be bounded regardless of heading count.
    const bigMd = '\n'.repeat(200_000) + '# too far to see';
    const index = buildHeadingIndex(bigMd);
    expect(index.lines.length).toBeLessThanOrEqual(50_000);
    // The one heading lives past the cap, so it must not be found.
    expect(tocFromHeadingIndex(index)).toHaveLength(0);
  });

  it('still finds headings comfortably within the line cap', () => {
    const md = '\n'.repeat(10) + '# Reachable';
    expect(extractToc(md).map((t) => t.title)).toEqual(['Reachable']);
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

describe('buildHeadingIndex / tocFromHeadingIndex / sectionFromHeadingIndex', () => {
  // local.ts/remote.ts now build one of these per cached page and reuse it
  // across repeated getToc()/getSection() calls instead of re-scanning the
  // markdown from scratch every time (see buildHeadingIndex's doc comment).
  // These wrappers must stay behaviorally identical to the one-shot
  // extractToc()/extractSection() functions they're built from.
  const md = `# Top\n\nintro text\n\n## Setup\n\nsetup body\n\n### Sub\n\nsub body\n\n## Other\n\nother body`;

  it('tocFromHeadingIndex(buildHeadingIndex(md)) matches extractToc(md)', () => {
    expect(tocFromHeadingIndex(buildHeadingIndex(md))).toEqual(extractToc(md));
  });

  it('sectionFromHeadingIndex(buildHeadingIndex(md), anchor) matches extractSection(md, anchor) for every anchor in the toc', () => {
    const index = buildHeadingIndex(md);
    for (const { anchor } of tocFromHeadingIndex(index)) {
      expect(sectionFromHeadingIndex(index, anchor)).toEqual(extractSection(md, anchor));
    }
  });

  it('reuses one built index correctly across multiple different-anchor lookups, in a different order than they appear in the document', () => {
    // The whole point of exporting these separately from extractToc()/
    // extractSection() is that one HeadingIndex gets reused across many
    // lookups against the same cached page - so looking up several
    // different anchors against the *same* index object must return
    // correct, mutually independent results each time, not just on the
    // first call.
    const index = buildHeadingIndex(md);
    const other = sectionFromHeadingIndex(index, 'other');
    const setup = sectionFromHeadingIndex(index, 'setup');
    const top = sectionFromHeadingIndex(index, 'top');
    expect(other?.markdown).toContain('other body');
    expect(other?.markdown).not.toContain('setup body');
    expect(setup?.markdown).toContain('setup body');
    expect(setup?.markdown).toContain('sub body');
    expect(setup?.markdown).not.toContain('other body');
    expect(top?.markdown).toContain('intro text');
  });

  it('returns null from sectionFromHeadingIndex for an anchor not present in the index', () => {
    expect(sectionFromHeadingIndex(buildHeadingIndex(md), 'nope')).toBeNull();
  });
});
