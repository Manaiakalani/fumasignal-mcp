import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
