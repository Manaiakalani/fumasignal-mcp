import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalFumadocsSource } from '../src/sources/local.js';
import { logger } from '../src/lib/logger.js';

/** True if `s` contains a lone (unpaired) UTF-16 surrogate anywhere. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-'));
  const docs = path.join(tmpDir, 'content', 'docs');
  await mkdir(docs, { recursive: true });
  await writeFile(
    path.join(docs, 'index.mdx'),
    `---\ntitle: Hello\ndescription: hi there\n---\n\n# Hello\n\n## Section A\n\nalpha apples\n\n## Section B\n\nbeta bananas\n`,
  );
  await mkdir(path.join(docs, 'guides'), { recursive: true });
  await writeFile(
    path.join(docs, 'guides', 'install.mdx'),
    `---\ntitle: Install\n---\n\n# Install\n\nrun npm install for apples`,
  );
  await writeFile(path.join(tmpDir, 'llms.txt'), 'this is llms.txt');
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe('LocalFumadocsSource', () => {
  it('lists pages with index normalized to /docs', async () => {
    const src = new LocalFumadocsSource({ rootDir: tmpDir });
    const pages = await src.listPages();
    const urls = pages.map((p) => p.url);
    expect(urls).toContain('/docs');
    expect(urls).toContain('/docs/guides/install');
  });

  it('searches with title-weighted scoring', async () => {
    const src = new LocalFumadocsSource({ rootDir: tmpDir });
    const hits = await src.search({ query: 'apples' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toMatch(/Hello|Install/);
  });

  it('returns ranked hits when a token appears in title', async () => {
    const src = new LocalFumadocsSource({ rootDir: tmpDir });
    const hits = await src.search({ query: 'install' });
    expect(hits[0]!.url).toBe('/docs/guides/install');
  });

  it('deduplicates repeated query tokens instead of scoring each repetition separately', async () => {
    // Regression: search() scored every token in the split query
    // independently, with no deduplication - a query that repeats the
    // same word many times (the cheapest way to maximize token count
    // within the query's fixed character budget) multiplied that page's
    // score (and, more importantly, the scanning cost) by the repeat
    // count for no semantic benefit. "apples" and "apples apples apples"
    // must score identically once repeats collapse to a single token.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-searchdedup-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, 'fruit.md'), '# Fruit\n\napples apples apples grow on trees');
      const src = new LocalFumadocsSource({ rootDir: dir });
      const once = await src.search({ query: 'apples' });
      const repeated = await src.search({ query: 'apples apples apples' });
      expect(once).toHaveLength(1);
      expect(repeated).toHaveLength(1);
      expect(repeated[0]!.score).toBe(once[0]!.score);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('only scores the first MAX_SEARCH_TOKENS distinct tokens of a query, ignoring the rest', async () => {
    // Regression: with no cap, search()'s cost is
    // O(distinct token count * total indexed bytes) - the query MCP tool
    // parameter allows up to ~250 single-character tokens (500-char cap /
    // 2), which against a fully-populated default-sized index was
    // empirically measured at 10-25+ seconds of synchronous,
    // event-loop-blocking work for one call. Crafts a query with 21
    // distinct one-word tokens, where only the 21st (beyond the 20-token
    // cap) appears anywhere in the corpus - if the cap is enforced, that
    // token is never scored and the page it would have matched shouldn't
    // appear in the results at all.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-searchcap-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, 'needle.md'), '# Needle\n\ncontains-only-token21-zzz here');
      const src = new LocalFumadocsSource({ rootDir: dir });
      const tokens = Array.from({ length: 20 }, (_, i) => `unused-token-${i}`);
      tokens.push('contains-only-token21-zzz');
      const hits = await src.search({ query: tokens.join(' ') });
      expect(hits).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gets a page by URL ref', async () => {
    const src = new LocalFumadocsSource({ rootDir: tmpDir });
    const page = await src.getPage('/docs/guides/install');
    expect(page.title).toBe('Install');
    expect(page.markdown).toContain('npm install');
  });

  it('gets a page by slug', async () => {
    const src = new LocalFumadocsSource({ rootDir: tmpDir });
    const page = await src.getPage('guides/install');
    expect(page.title).toBe('Install');
  });

  it('decodes a percent-encoded ref to match an indexed page whose slug needs encoding', async () => {
    // Regression: buildIndex() keys pages by literal (unencoded)
    // filesystem-derived paths - a file "API Reference.mdx" is keyed as
    // "/docs/guides/API Reference" with a real space, never "%20". A
    // percent-encoded ref (an absolute URL's `.pathname` is always
    // percent-encoded by the URL parser, and a hand-constructed path ref
    // may be too) used to never match, 404-ing get_page for any file
    // whose slug needs URL-encoding.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-encoded-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(path.join(docs, 'guides'), { recursive: true });
      await writeFile(
        path.join(docs, 'guides', 'API Reference.mdx'),
        '---\ntitle: API Reference\n---\n\n# API Reference\n\nbody text',
      );
      const src = new LocalFumadocsSource({ rootDir: dir });
      const byPath = await src.getPage('/docs/guides/API%20Reference');
      expect(byPath.title).toBe('API Reference');
      const byAbsoluteUrl = await src.getPage('https://example.com/docs/guides/API%20Reference');
      expect(byAbsoluteUrl.title).toBe('API Reference');
      // The literal (unencoded) form - what listPages() itself returns -
      // must keep working too.
      const byLiteral = await src.getPage('/docs/guides/API Reference');
      expect(byLiteral.title).toBe('API Reference');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never returns a search excerpt with a dangling UTF-16 surrogate, even when the context window lands mid-emoji', async () => {
    // Regression: snippet() sliced `body` at `idx - contextChars` /
    // `idx + needle.length + contextChars` with no awareness of UTF-16
    // surrogate pairs - a supplementary-plane character (e.g. an emoji)
    // straddling either boundary gets split, leaving a lone high/low
    // surrogate in the returned excerpt (not well-formed Unicode). With
    // 45 emoji (90 UTF-16 units) padding each side of "target" and the
    // real default contextChars=80, both the start and end boundaries
    // land mid-pair - empirically confirmed against the pre-fix logic.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-surrogate-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      const emoji = '😀'.repeat(45);
      await writeFile(path.join(docs, 'emoji.md'), `# Emoji\n\n${emoji} target ${emoji}`);
      const src = new LocalFumadocsSource({ rootDir: dir });
      const hits = await src.search({ query: 'target' });
      expect(hits).toHaveLength(1);
      const excerpt = hits[0]!.excerpt;
      expect(excerpt).toBeDefined();
      expect(excerpt).toContain('target');
      expect(hasLoneSurrogate(excerpt!)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a real search excerpt even when case-folding would change the match offset', async () => {
    // Regression: snippet() found the match's offset in
    // `body.toLowerCase()` and then sliced the *original* `body` at that
    // same numeric offset - silently assuming toLowerCase() never
    // changes a string's length. Turkish "İ" (U+0130) lowercases to a
    // 2-code-unit "i" + combining dot above, so 120 of them before a
    // match shifted the lowercased offset 120 UTF-16 units past the real
    // one in `body`, producing a `start > end` slice - empirically
    // confirmed against the pre-fix logic, this returned just "…" with
    // no excerpt content at all despite a genuine match.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-casefold-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      const padding = 'İ'.repeat(120);
      await writeFile(path.join(docs, 'casefold.md'), `# Casefold\n\n${padding} target text here`);
      const src = new LocalFumadocsSource({ rootDir: dir });
      const hits = await src.search({ query: 'target' });
      expect(hits).toHaveLength(1);
      const excerpt = hits[0]!.excerpt;
      expect(excerpt).toBeDefined();
      expect(excerpt).toContain('target text here');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts a section by anchor', async () => {
    const src = new LocalFumadocsSource({ rootDir: tmpDir });
    const section = await src.getSection('/docs', 'section-a');
    expect(section.title).toBe('Section A');
    expect(section.markdown).toContain('alpha apples');
    expect(section.markdown).not.toContain('beta');
  });

  it('returns correct, independent results across repeated getSection()/getToc() calls for the same page', async () => {
    // Functional regression for the getSection()/buildIndex() refactor:
    // IndexedPage now stores one HeadingIndex, computed once in
    // buildIndex(), that getSection() reads from on every call instead of
    // recomputing from the page body each time. Repeated calls - in a
    // different order, and interleaved with getToc() - against the same
    // page must all still return correct, mutually independent results.
    const src = new LocalFumadocsSource({ rootDir: tmpDir });
    const b = await src.getSection('/docs', 'section-b');
    const toc = await src.getToc('/docs');
    const a = await src.getSection('/docs', 'section-a');
    expect(b.markdown).toContain('beta bananas');
    expect(b.markdown).not.toContain('alpha');
    expect(a.markdown).toContain('alpha apples');
    expect(a.markdown).not.toContain('beta');
    expect(toc.map((t) => t.anchor)).toEqual(['hello', 'section-a', 'section-b']);
  });

  it('returns toc with anchors', async () => {
    const src = new LocalFumadocsSource({ rootDir: tmpDir });
    const toc = await src.getToc('/docs');
    expect(toc.map((t) => t.anchor)).toContain('section-a');
    expect(toc.map((t) => t.anchor)).toContain('section-b');
  });

  it('returns frontmatter via getMeta', async () => {
    const src = new LocalFumadocsSource({ rootDir: tmpDir });
    const meta = await src.getMeta('/docs');
    expect(meta.title).toBe('Hello');
    expect(meta.description).toBe('hi there');
  });

  it('reads llms.txt from project root', async () => {
    const src = new LocalFumadocsSource({ rootDir: tmpDir });
    expect(await src.getLlmsTxt()).toBe('this is llms.txt');
    expect(await src.getLlmsTxt(true)).toBeNull();
  });

  it('throws NotFoundError on unknown ref', async () => {
    const src = new LocalFumadocsSource({ rootDir: tmpDir });
    await expect(src.getPage('/docs/nope')).rejects.toThrow(/not found/i);
  });
});

describe('LocalFumadocsSource security fixes', () => {
  it('does not eval() frontmatter tagged with a javascript/js engine, and does not let one bad file break the whole index', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-evil-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(
        path.join(docs, 'safe.mdx'),
        `---\ntitle: Safe\n---\n\n# Safe\n\nfine`,
      );
      // gray-matter's default engines execute this frontmatter body via
      // eval()/Function() when the fence declares a "javascript"/"js"
      // language. If that were still enabled, this would set the global.
      await writeFile(
        path.join(docs, 'evil.mdx'),
        `---javascript\nglobalThis.__fumasignal_pwned = true;\nmodule.exports = { title: "Evil" };\n---\n\nshould not load`,
      );
      const src = new LocalFumadocsSource({ rootDir: dir });
      const pages = await src.listPages();
      expect((globalThis as Record<string, unknown>).__fumasignal_pwned).toBeUndefined();
      expect(pages.map((p) => p.url)).toContain('/docs/safe');
      expect(pages.map((p) => p.url)).not.toContain('/docs/evil');
    } finally {
      delete (globalThis as Record<string, unknown>).__fumasignal_pwned;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not crash search() when a page has a non-string YAML title', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-badtitle-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      // A YAML frontmatter title of `42` parses as a number, not a string.
      // Regression: `buildIndex()` used to cast it with `as string`
      // (a compile-time-only assertion), so `page.title.toLowerCase()` in
      // `search()` would throw `TypeError: page.title.toLowerCase is not a
      // function` for the WHOLE index, not just this page. `description: true`
      // exercises the same guard (asNonEmptyString) on the description field.
      await writeFile(
        path.join(docs, 'numeric-title.mdx'),
        `---\ntitle: 42\ndescription: true\n---\n\n# Fallback Heading\n\nwidget content here`,
      );
      await writeFile(
        path.join(docs, 'normal.mdx'),
        `---\ntitle: Normal Page\n---\n\n# Normal\n\nwidget content here too`,
      );
      const src = new LocalFumadocsSource({ rootDir: dir });
      const hits = await src.search({ query: 'widget' });
      expect(hits.map((h) => h.url).sort()).toEqual(['/docs/normal', '/docs/numeric-title']);
      // Falls back to the first markdown heading when the YAML title isn't a string.
      const badPage = await src.getPage('/docs/numeric-title');
      expect(badPage.title).toBe('Fallback Heading');
      expect(badPage.description).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not hang extracting a title from a large adversarial heading line (ReDoS regression)', async () => {
    // Regression: firstHeading() used `/^#\s+(.+?)\s*$/m` - the same
    // catastrophic-backtracking shape as HEADING_RE in src/lib/markdown.ts
    // and extractTitle() in src/sources/remote.ts. A line with no valid
    // trailing match forces the old regex to exhaust every split point.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-redos-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      const adversarial = '# a' + ' '.repeat(200 * 1024) + '!';
      await writeFile(path.join(docs, 'adversarial.mdx'), `${adversarial}\n\nbody text`);
      const src = new LocalFumadocsSource({ rootDir: dir });
      const start = Date.now();
      const page = await src.getPage('/docs/adversarial');
      expect(Date.now() - start).toBeLessThan(1000);
      expect(page.title.endsWith('!')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('filters search results by tag and locale', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-tags-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(
        path.join(docs, 'a.mdx'),
        `---\ntitle: A\ntag: v1\nlocale: en\n---\n\n# A\n\nwidget content`,
      );
      await writeFile(
        path.join(docs, 'b.mdx'),
        `---\ntitle: B\ntag: v2\nlocale: en\n---\n\n# B\n\nwidget content`,
      );
      await writeFile(
        path.join(docs, 'c.mdx'),
        `---\ntitle: C\ntag: v1\nlocale: fr\n---\n\n# C\n\nwidget content`,
      );
      const src = new LocalFumadocsSource({ rootDir: dir });
      const byTag = await src.search({ query: 'widget', tag: 'v1' });
      expect(byTag.map((h) => h.url).sort()).toEqual(['/docs/a', '/docs/c']);
      const byTagAndLocale = await src.search({ query: 'widget', tag: 'v1', locale: 'en' });
      expect(byTagAndLocale.map((h) => h.url)).toEqual(['/docs/a']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to follow a symlink that escapes the project root for llms.txt',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-symlink-'));
      const outside = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-outside-'));
      try {
        const secretPath = path.join(outside, 'secret.txt');
        await writeFile(secretPath, 'SECRET_CONTENT_OUTSIDE_ROOT');
        await symlink(secretPath, path.join(dir, 'llms.txt'));
        const src = new LocalFumadocsSource({ rootDir: dir });
        const result = await src.getLlmsTxt();
        expect(result).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses to index a contentDir that is itself a symlink escaping the project root',
    async () => {
      // Regression: fs.stat() (used to validate contentDir before walking)
      // follows symlinks, and fs.readdir() on a symlinked directory
      // transparently follows it too. walk()'s own symlink guard only
      // protects entries found *during* the walk, not the starting
      // directory - so a malicious cloned docs repo that replaces
      // content/docs with a symlink to an arbitrary host directory could
      // otherwise get that directory's .md/.mdx files indexed and served.
      const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-escape-'));
      const outside = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-outside-'));
      try {
        await writeFile(
          path.join(outside, 'leaked.md'),
          '# Leaked\n\nThis file lives outside the intended project root.',
        );
        await mkdir(path.join(dir, 'content'), { recursive: true });
        await symlink(outside, path.join(dir, 'content', 'docs'), 'dir');
        const src = new LocalFumadocsSource({ rootDir: dir });
        await expect(src.listPages()).rejects.toThrow(/outside the project root/i);
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it('allows an explicit absolute --content-dir outside rootDir (not an escape - operator-configured)', async () => {
    // The symlink-escape guard above only applies when contentDir is
    // derived by joining rootDir with a relative path (the default). An
    // explicit absolute --content-dir is intentionally allowed to point
    // anywhere, since it's supplied directly by whoever runs the server,
    // not discovered by walking an untrusted repo.
    const outside = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-explicit-'));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-root-'));
    try {
      await writeFile(path.join(outside, 'page.md'), '# Explicit\n\nallowed by explicit config');
      const src = new LocalFumadocsSource({ rootDir: dir, contentDir: outside });
      const pages = await src.listPages();
      expect(pages.map((p) => p.url)).toEqual(['/docs/page']);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('skips indexing a file that exceeds maxFileBytes instead of reading it in full', async () => {
    // Regression: buildIndex() used to read every .md/.mdx file's full
    // contents into memory with no size check at all. contentDir can point
    // at an untrusted cloned docs repo (same threat model as the symlink
    // checks above), and every indexed page is retained for the process's
    // lifetime with no eviction - so one oversized file, deliberate or
    // not, would otherwise be read and held in full unconditionally.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-maxfile-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, 'small.md'), '# Small\n\nfits under the cap');
      await writeFile(path.join(docs, 'huge.md'), `# Huge\n\n${'x'.repeat(1000)}`);
      const src = new LocalFumadocsSource({ rootDir: dir, maxFileBytes: 100 });
      const pages = await src.listPages();
      expect(pages.map((p) => p.url)).toEqual(['/docs/small']);
      expect(pages.map((p) => p.url)).not.toContain('/docs/huge');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to read an llms.txt that exceeds maxFileBytes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-maxfile-llms-'));
    try {
      await writeFile(path.join(dir, 'llms.txt'), 'x'.repeat(1000));
      const src = new LocalFumadocsSource({ rootDir: dir, maxFileBytes: 100 });
      expect(await src.getLlmsTxt()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still indexes and reads files at or under the default maxFileBytes cap', async () => {
    // Sanity check that the new cap doesn't affect ordinary, reasonably
    // sized content using the default (no maxFileBytes passed).
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-maxfile-default-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, 'normal.md'), '# Normal\n\nordinary sized page');
      await writeFile(path.join(dir, 'llms.txt'), 'ordinary llms.txt content');
      const src = new LocalFumadocsSource({ rootDir: dir });
      const pages = await src.listPages();
      expect(pages.map((p) => p.url)).toEqual(['/docs/normal']);
      expect(await src.getLlmsTxt()).toBe('ordinary llms.txt content');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops indexing once the aggregate maxTotalBytes budget is exhausted, even though every file is under maxFileBytes', async () => {
    // Regression: buildIndex() only ever capped a single file's size
    // (maxFileBytes). An untrusted cloned docs repo with many files each
    // just under that per-file cap can still, in aggregate, retain far
    // more in memory than any one file would - every indexed page's
    // body/toc/meta lives for the process's lifetime with no eviction.
    // maxTotalBytes closes that gap. Three 100-byte files against a
    // 150-byte aggregate budget: exactly one must fit regardless of which
    // file the walk happens to process first (100 fits; a second 100
    // always overshoots 150 no matter which two of the three are tried).
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-maxtotal-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      for (const name of ['a', 'b', 'c']) {
        await writeFile(path.join(docs, `${name}.md`), 'x'.repeat(100));
      }
      const src = new LocalFumadocsSource({ rootDir: dir, maxTotalBytes: 150 });
      const pages = await src.listPages();
      expect(pages.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('charges maxTotalBytes for a file that fails to parse, not just ones that index successfully', async () => {
    // Regression: totalBytes used to be incremented on the line *after*
    // parseFrontmatter() succeeded, so a file that read fine but failed to
    // parse (or failed for any other reason) paid the real I/O/CPU cost of
    // a full fs.readFile() while contributing nothing to the aggregate
    // budget maxTotalBytes exists to bound. Uses three files that all fail
    // to parse (a disabled "javascript" front-matter engine - see
    // frontmatter.ts - reliably throws without depending on content
    // size/shape), each the same size, with maxTotalBytes set so the
    // budget can only trip once *two* files' bytes have been charged. Since
    // all three files are interchangeable (same size, same failure mode),
    // the outcome doesn't depend on which particular one the filesystem
    // happens to enumerate first/second/third - only on whether a failing
    // file's bytes get charged at all. Asserts via the "budget exhausted"
    // warning's logged totalBytes value, since pages.length is 0 either
    // way here (every file fails to parse) and can't distinguish the fix
    // from the bug on its own.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-totalbytes-onfail-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      const body = '---javascript\nx\n---\n# Body\n' + 'y'.repeat(70);
      for (const name of ['one', 'two', 'three']) {
        await writeFile(path.join(docs, `${name}.md`), body);
      }
      const warnSpy = vi.spyOn(logger, 'warn');
      try {
        const src = new LocalFumadocsSource({
          rootDir: dir,
          maxTotalBytes: Math.floor(body.length * 1.5),
        });
        const pages = await src.listPages();
        expect(pages.length).toBe(0);
        const budgetCall = warnSpy.mock.calls.find(
          (call) =>
            typeof call[1] === 'string' && call[1].includes('maxTotalBytes budget exhausted'),
        );
        expect(budgetCall).toBeDefined();
        // A single file's worth of bytes must have been charged even
        // though it failed to parse - if the pre-fix bug were present,
        // failing files would never advance totalBytes, this warning would
        // never fire at all (every file's check would see totalBytes still
        // at 0), and this .find() would come back undefined instead.
        expect((budgetCall?.[0] as { totalBytes: number }).totalBytes).toBe(body.length);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not let maxTotalBytes affect a docs tree that fits comfortably under the default budget', async () => {
    // Sanity check that the new aggregate cap doesn't affect ordinary,
    // reasonably sized content using the default (no maxTotalBytes passed).
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-maxtotal-default-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      for (const name of ['a', 'b', 'c']) {
        await writeFile(path.join(docs, `${name}.md`), `# ${name}\n\nordinary sized page`);
      }
      const src = new LocalFumadocsSource({ rootDir: dir });
      const pages = await src.listPages();
      expect(pages.length).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops indexing once maxFileCount is reached, even though the aggregate byte budget has room to spare', async () => {
    // Regression: maxTotalBytes alone doesn't bound the *number* of
    // indexed pages - a directory with an extremely large number of tiny
    // files (each far under maxFileBytes, and collectively far under
    // maxTotalBytes) still costs a Map entry plus a toc/meta object per
    // file. maxFileCount bounds that independently, the same way
    // MAX_SITEMAP_URLS bounds sitemap URL count independently of
    // MAX_SITEMAP_URL_BYTES in remote.ts. Five tiny files against a
    // maxFileCount of 3 must index exactly 3, regardless of which three
    // the walk happens to reach first.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-maxcount-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      for (let i = 0; i < 5; i++) {
        await writeFile(path.join(docs, `p${i}.md`), `# Page ${i}`);
      }
      const src = new LocalFumadocsSource({ rootDir: dir, maxFileCount: 3 });
      const pages = await src.listPages();
      expect(pages.length).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops walk() itself from descending into further directories once maxFileCount is reached, not just from indexing further files', async () => {
    // Regression: walk() used to fully enumerate every matching file path
    // in the tree - recursing into every subdirectory no matter what -
    // before buildIndex() ever got a chance to apply maxFileCount. For an
    // extremely large tree, that means walk() itself (not just the later
    // read/index step) could momentarily hold megabytes of path strings
    // in memory before the budget was ever consulted. walk() now takes a
    // limit and stops enumerating once it's reached, so verify fs.opendir
    // is never even called for a sibling subdirectory once the budget is
    // already exhausted. Uses two sibling subdirectories, each with one
    // file, and maxFileCount: 1 - regardless of which of the two
    // subdirectories the filesystem happens to enumerate first, walk()
    // must find its one allowed file there and stop before descending
    // into the other, so exactly 2 directories (the content root + one
    // subdirectory) should ever be passed to fs.opendir, never 3.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-walklimit-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(path.join(docs, 'a'), { recursive: true });
      await mkdir(path.join(docs, 'z'), { recursive: true });
      await writeFile(path.join(docs, 'a', 'one.md'), '# One');
      await writeFile(path.join(docs, 'z', 'two.md'), '# Two');
      const opendirSpy = vi.spyOn(fsPromises, 'opendir');
      try {
        const src = new LocalFumadocsSource({ rootDir: dir, maxFileCount: 1 });
        const pages = await src.listPages();
        expect(pages.length).toBe(1);
        expect(opendirSpy.mock.calls.length).toBe(2);
      } finally {
        opendirSpy.mockRestore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops walk() from reading further entries within a single large flat directory once limit is reached', async () => {
    // Regression: even after the fix above (which stops walk() from
    // *recursing into further subdirectories* once maxFileCount is
    // exhausted), each individual walk() call still read every entry of
    // *one* directory in a single fs.readdir() call before its own `limit`
    // check ever ran - so one flat directory containing an extremely large
    // number of files (no subdirectories at all, so the recursion-limiting
    // fix above never even applies) would still be fully enumerated and
    // buffered into memory regardless of maxFileCount. walk() now uses
    // fs.opendir()'s async-iterable Dir, which reads entries incrementally,
    // so breaking out of the loop once `limit` is hit stops it from ever
    // reading (or materializing a Dirent for) any further entries in that
    // same directory. Verified here via a content root with 5 files and
    // maxFileCount: 2: only 2 pages should be indexed, and the directory
    // handle must not have been asked to enumerate more than necessary.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-walkflat-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      for (let i = 0; i < 5; i++) {
        await writeFile(path.join(docs, `page-${i}.md`), `# Page ${i}`);
      }
      const src = new LocalFumadocsSource({ rootDir: dir, maxFileCount: 2 });
      const pages = await src.listPages();
      expect(pages.length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips an unreadable subdirectory during the index walk instead of aborting the whole build', async () => {
    // Regression: walk() had no try/catch around its recursive descent
    // into subdirectories, so a single unreadable one (permission denied,
    // removed mid-walk, etc.) rejected the *entire* walk() call - and with
    // it, the entire buildIndex() build - even though every *other* file
    // in the tree was perfectly readable. Simulated here by making
    // fs.opendir reject specifically for one subdirectory while behaving
    // normally for every other path (including the content root itself);
    // the sibling directory's page must still be indexed, and a warning
    // must be logged identifying the skipped subdirectory.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-badsubdir-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(path.join(docs, 'good'), { recursive: true });
      await mkdir(path.join(docs, 'bad'), { recursive: true });
      await writeFile(path.join(docs, 'good', 'ok.md'), '# OK\n\nreadable page');
      await writeFile(path.join(docs, 'bad', 'unreachable.md'), '# Unreachable');
      const badDir = path.resolve(path.join(docs, 'bad'));
      const realOpendir = fsPromises.opendir;
      const opendirSpy = vi
        .spyOn(fsPromises, 'opendir')
        .mockImplementation(((p: string) => {
          if (path.resolve(String(p)) === badDir) {
            return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
          }
          return realOpendir(p);
        }) as typeof fsPromises.opendir);
      const warnSpy = vi.spyOn(logger, 'warn');
      try {
        const src = new LocalFumadocsSource({ rootDir: dir });
        const pages = await src.listPages();
        expect(pages.map((p) => p.url)).toEqual(['/docs/good/ok']);
        const skipCall = warnSpy.mock.calls.find(
          (call) =>
            typeof call[1] === 'string' && call[1].includes('skipping unreadable subdirectory'),
        );
        expect(skipCall).toBeDefined();
      } finally {
        opendirSpy.mockRestore();
        warnSpy.mockRestore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retries indexing on the next call instead of caching a build failure forever', async () => {
    // Regression: index() memoized buildIndex()'s promise unconditionally
    // ("if (!this.indexPromise) this.indexPromise = this.buildIndex()"),
    // including when it rejected - so a single transient failure (e.g. a
    // network-mounted contentDir that hiccups on the very first request)
    // poisoned the source forever: every subsequent listPages()/search()/
    // getPage() call replayed that same rejected promise instead of ever
    // trying again, even long after whatever caused the failure was gone.
    // Simulated here by making fs.opendir reject exactly once (on the
    // first call only) and behave normally afterwards: the first
    // listPages() call must reject, but a second call right after must
    // succeed with the real content instead of replaying the same error.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fumasignal-local-retry-'));
    try {
      const docs = path.join(dir, 'content', 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, 'ok.md'), '# OK\n\nreadable page');
      const realOpendir = fsPromises.opendir;
      let calls = 0;
      const opendirSpy = vi
        .spyOn(fsPromises, 'opendir')
        .mockImplementation(((p: string) => {
          calls += 1;
          if (calls === 1) {
            return Promise.reject(Object.assign(new Error('transient failure'), { code: 'EIO' }));
          }
          return realOpendir(p);
        }) as typeof fsPromises.opendir);
      try {
        const src = new LocalFumadocsSource({ rootDir: dir });
        await expect(src.listPages()).rejects.toThrow();
        const pages = await src.listPages();
        expect(pages.map((p) => p.url)).toEqual(['/docs/ok']);
      } finally {
        opendirSpy.mockRestore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
