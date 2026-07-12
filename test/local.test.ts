import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalFumadocsSource } from '../src/sources/local.js';

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

  it('extracts a section by anchor', async () => {
    const src = new LocalFumadocsSource({ rootDir: tmpDir });
    const section = await src.getSection('/docs', 'section-a');
    expect(section.title).toBe('Section A');
    expect(section.markdown).toContain('alpha apples');
    expect(section.markdown).not.toContain('beta');
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
});
