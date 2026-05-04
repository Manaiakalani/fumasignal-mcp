import { describe, it, expect } from 'vitest';
import { extractToc, extractSection, slugify } from '../src/lib/markdown.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('  Trim Me  ')).toBe('trim-me');
    expect(slugify('Special!@# chars')).toBe('special-chars');
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
});
