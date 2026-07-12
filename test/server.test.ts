import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import {
  type FumadocsSource,
  type PageContent,
  type PageSummary,
  type SearchHit,
  type SearchOptions,
  type TocEntry,
  NotFoundError,
  SourceError,
} from '../src/sources/types.js';

/**
 * Minimal, fully in-memory fake source so these tests exercise only
 * server.ts's own tool-response shaping (truncation, error formatting) -
 * not any real source implementation's behavior, which is covered by
 * local.test.ts/remote.test.ts instead.
 */
class FakeSource implements FumadocsSource {
  readonly label = 'fake';
  constructor(
    private data: {
      hits?: SearchHit[];
      pages?: PageSummary[];
      page?: PageContent;
      toc?: TocEntry[];
      meta?: Record<string, unknown>;
      section?: { title: string; markdown: string };
      llmsTxt?: string | null;
      throwOn?: 'getPage' | 'getSection' | 'getToc' | 'getMeta';
      throwError?: Error;
    } = {},
  ) {}

  private maybeThrow(method: string): void {
    if (this.data.throwOn === method) throw this.data.throwError ?? new NotFoundError('not found');
  }

  async search(_opts: SearchOptions): Promise<SearchHit[]> {
    return this.data.hits ?? [];
  }
  async listPages(_prefix?: string): Promise<PageSummary[]> {
    return this.data.pages ?? [];
  }
  async getPage(_ref: string): Promise<PageContent> {
    this.maybeThrow('getPage');
    if (!this.data.page) throw new NotFoundError('no page configured');
    return this.data.page;
  }
  async getToc(_ref: string): Promise<TocEntry[]> {
    this.maybeThrow('getToc');
    return this.data.toc ?? [];
  }
  async getMeta(_ref: string): Promise<Record<string, unknown>> {
    this.maybeThrow('getMeta');
    return this.data.meta ?? {};
  }
  async getSection(_ref: string, _anchor: string): Promise<{ title: string; markdown: string }> {
    this.maybeThrow('getSection');
    if (!this.data.section) throw new NotFoundError('no section configured');
    return this.data.section;
  }
  async getLlmsTxt(_full?: boolean): Promise<string | null> {
    return this.data.llmsTxt ?? null;
  }
}

let activeClient: Client | undefined;

/** Connect a fresh client+server pair over the SDK's in-memory transport. */
async function connect(source: FumadocsSource): Promise<Client> {
  const server = createServer(source);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  activeClient = client;
  return client;
}

afterEach(async () => {
  await activeClient?.close();
  activeClient = undefined;
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('');
}

describe('MCP tool result size cap (MAX_TOOL_RESULT_CHARS)', () => {
  it('truncates an oversized get_toc result instead of returning it in full', async () => {
    // Regression: get_toc had no size cap of its own - a page with an
    // extremely large number of headings (or abnormally long heading
    // titles) could otherwise produce a multi-MB tool response.
    const toc: TocEntry[] = Array.from({ length: 20_000 }, (_, i) => ({
      depth: 1,
      title: `Heading number ${i} with some extra padding text to grow the payload`,
      anchor: `heading-${i}`,
    }));
    const client = await connect(new FakeSource({ toc }));
    const result = await client.callTool({ name: 'get_toc', arguments: { ref: '/docs/big' } });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text.length).toBeLessThan(210_000);
    expect(text).toContain('response truncated');
    expect((result as { _meta?: { truncated?: boolean } })._meta?.truncated).toBe(true);
  });

  it('never returns a truncated result longer than the documented 200,000-character hard ceiling', async () => {
    // Regression: the truncation notice used to be appended *after*
    // slicing to the full 200,000-character limit, so a truncated result
    // was actually ~115 characters longer than the "hard ceiling"
    // MAX_TOOL_RESULT_CHARS's doc comment promises. Uses a payload large
    // enough that the exact overshoot (if the bug were present) would
    // clearly show up as a length just over 200,000 rather than under it.
    const toc: TocEntry[] = Array.from({ length: 20_000 }, (_, i) => ({
      depth: 1,
      title: `Heading number ${i} with some extra padding text to grow the payload`,
      anchor: `heading-${i}`,
    }));
    const client = await connect(new FakeSource({ toc }));
    const result = await client.callTool({ name: 'get_toc', arguments: { ref: '/docs/big' } });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text.length).toBeLessThanOrEqual(200_000);
    expect(text).toContain('response truncated at 200000');
  });

  it('truncates an oversized get_meta result instead of returning it in full', async () => {
    // Regression: get_meta JSON.stringify()'s arbitrary frontmatter with
    // no cap - a crafted/huge frontmatter block had nothing bounding the
    // resulting tool response.
    const meta = { notes: 'x'.repeat(500_000) };
    const client = await connect(new FakeSource({ meta }));
    const result = await client.callTool({ name: 'get_meta', arguments: { ref: '/docs/big' } });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text.length).toBeLessThan(210_000);
    expect(text).toContain('response truncated');
  });

  it('truncates an oversized get_section result instead of returning it in full', async () => {
    // Regression: get_section has no truncation of its own at all (unlike
    // get_page's MAX_PAGE_CHARS) - a page consisting of a single section
    // could return the *entire* body untruncated, defeating the point of
    // a "just one section" tool.
    const section = { title: 'Huge', markdown: 'y'.repeat(500_000) };
    const client = await connect(new FakeSource({ section }));
    const result = await client.callTool({ name: 'get_section', arguments: { ref: '/docs/big', anchor: 'x' } });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text.length).toBeLessThan(210_000);
    expect(text).toContain('response truncated');
  });

  it('truncates an oversized list_pages result instead of returning it in full', async () => {
    // Regression: list_pages concatenates every returned page's
    // title/description with no overall size cap - a source with many
    // pages, each carrying a long description, had nothing bounding the
    // combined response.
    const pages: PageSummary[] = Array.from({ length: 5_000 }, (_, i) => ({
      id: `/docs/p${i}`,
      url: `/docs/p${i}`,
      title: `Page ${i}`,
      description: 'd'.repeat(200),
    }));
    const client = await connect(new FakeSource({ pages }));
    const result = await client.callTool({ name: 'list_pages', arguments: {} });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text.length).toBeLessThan(210_000);
    expect(text).toContain('response truncated');
  });

  it('truncates an oversized error message instead of returning it in full', async () => {
    // The cap applies to error results too, not just successful ones -
    // an underlying error message is just as capable of being huge as a
    // successful payload (e.g. an error that echoes untrusted content).
    const client = await connect(
      new FakeSource({ throwOn: 'getMeta', throwError: new SourceError('z'.repeat(500_000)) }),
    );
    const result = await client.callTool({ name: 'get_meta', arguments: { ref: '/docs/x' } });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text.length).toBeLessThan(210_000);
    expect(text).toContain('response truncated');
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('does not truncate or alter ordinary, reasonably sized tool results', async () => {
    // Sanity check that the new cap doesn't affect normal usage.
    const client = await connect(
      new FakeSource({
        toc: [{ depth: 1, title: 'Intro', anchor: 'intro' }],
        meta: { title: 'Hello' },
        section: { title: 'Intro', markdown: '# Intro\n\nhello' },
        pages: [{ id: '/docs/a', url: '/docs/a', title: 'A' }],
      }),
    );
    const toc = await client.callTool({ name: 'get_toc', arguments: { ref: '/docs/a' } });
    expect(textOf(toc as { content: Array<{ type: string; text?: string }> })).toContain('Intro');
    expect((toc as { _meta?: { truncated?: boolean } })._meta).toBeUndefined();

    const meta = await client.callTool({ name: 'get_meta', arguments: { ref: '/docs/a' } });
    expect(textOf(meta as { content: Array<{ type: string; text?: string }> })).toContain('Hello');

    const section = await client.callTool({ name: 'get_section', arguments: { ref: '/docs/a', anchor: 'intro' } });
    expect(textOf(section as { content: Array<{ type: string; text?: string }> })).toContain('hello');

    const pages = await client.callTool({ name: 'list_pages', arguments: {} });
    expect(textOf(pages as { content: Array<{ type: string; text?: string }> })).toContain('/docs/a');
  });

  it('still applies get_page\'s own MAX_PAGE_CHARS truncation notice for a page just over that (but not the outer) cap', async () => {
    // The outer MAX_TOOL_RESULT_CHARS cap is set well above MAX_PAGE_CHARS
    // specifically so it doesn't interfere with get_page's own, more
    // specific truncation message pointing the caller at get_section.
    const page: PageContent = {
      id: '/docs/big',
      url: '/docs/big',
      title: 'Big',
      markdown: 'a'.repeat(70_000),
      meta: {},
      toc: [],
    };
    const client = await connect(new FakeSource({ page }));
    const result = await client.callTool({ name: 'get_page', arguments: { ref: '/docs/big' } });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain('more chars available via get_section');
    expect(text).not.toContain('response truncated at 200000');
  });
});
