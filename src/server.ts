import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from './lib/logger.js';
import {
  type FumadocsSource,
  NotFoundError,
  SourceError,
} from './sources/types.js';

const SERVER_NAME = 'fumasignal-mcp';
const SERVER_VERSION = '0.1.0';

/** Maximum characters of markdown returned per call (truncates with notice). */
const MAX_PAGE_CHARS = 60_000;

export function createServer(source: FumadocsSource): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerTools(server, source);
  return server;
}

function registerTools(server: McpServer, source: FumadocsSource): void {
  // ---- search_docs ---------------------------------------------------------
  server.registerTool(
    'search_docs',
    {
      title: 'Search Fumadocs',
      description:
        'Full-text search across the Fumadocs site. Returns ranked hits with URL, title, description and a matching excerpt.',
      inputSchema: {
        query: z.string().min(1).describe('Search query.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe('Max results to return (default 10, max 50).'),
        tag: z
          .string()
          .optional()
          .describe('Optional tag filter (used by Fumadocs multi-docs sites).'),
        locale: z.string().optional().describe('Optional locale filter (e.g. "en", "cn").'),
      },
    },
    async (args) => {
      try {
        const hits = await source.search({
          query: args.query,
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.tag !== undefined ? { tag: args.tag } : {}),
          ...(args.locale !== undefined ? { locale: args.locale } : {}),
        });
        if (hits.length === 0) {
          return textResult(`No results for "${args.query}".`);
        }
        const lines = hits.map((h, i) => {
          const head = `${i + 1}. ${h.title} — ${h.url}`;
          const desc = h.description ? `\n   ${h.description}` : '';
          const excerpt = h.excerpt ? `\n   > ${truncate(h.excerpt, 240)}` : '';
          return `${head}${desc}${excerpt}`;
        });
        return textResult(lines.join('\n\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- list_pages ----------------------------------------------------------
  server.registerTool(
    'list_pages',
    {
      title: 'List doc pages',
      description: 'List all known documentation pages, optionally filtered by URL path prefix.',
      inputSchema: {
        prefix: z
          .string()
          .optional()
          .describe('Filter to pages whose URL starts with this prefix (e.g. "/docs/api").'),
        limit: z.number().int().positive().max(1000).optional().describe('Max entries to return.'),
      },
    },
    async (args) => {
      try {
        const pages = await source.listPages(args.prefix);
        const limited = args.limit ? pages.slice(0, args.limit) : pages;
        if (limited.length === 0) {
          return textResult('No pages found.');
        }
        const lines = limited.map((p) => {
          const desc = p.description ? ` — ${p.description}` : '';
          return `- ${p.url} : ${p.title}${desc}`;
        });
        const header = `${limited.length} page(s)${pages.length !== limited.length ? ` (of ${pages.length} total)` : ''}:`;
        return textResult(`${header}\n${lines.join('\n')}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- get_page ------------------------------------------------------------
  server.registerTool(
    'get_page',
    {
      title: 'Get page content',
      description:
        'Fetch the full Markdown content of a documentation page. Pass either a URL path (e.g. "/docs/getting-started"), an absolute URL on the same site, or a slug relative to the docs prefix.',
      inputSchema: {
        ref: z
          .string()
          .min(1)
          .describe('URL path, absolute URL, or slug of the page to fetch.'),
        include_meta: z
          .boolean()
          .optional()
          .describe('If true, prepend frontmatter metadata as a code block.'),
      },
    },
    async (args) => {
      try {
        const page = await source.getPage(args.ref);
        let body = page.markdown;
        let truncated = false;
        if (body.length > MAX_PAGE_CHARS) {
          body = `${body.slice(0, MAX_PAGE_CHARS)}\n\n…[truncated; ${body.length - MAX_PAGE_CHARS} more chars available via get_section]`;
          truncated = true;
        }
        const head = `# ${page.title}\n\n_URL: ${page.url}_${page.description ? `\n\n${page.description}` : ''}`;
        const metaBlock = args.include_meta
          ? `\n\n\`\`\`json\n${JSON.stringify(page.meta, null, 2)}\n\`\`\`\n`
          : '';
        const content = `${head}${metaBlock}\n\n${body}`;
        return textResult(content, { truncated });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- get_section ---------------------------------------------------------
  server.registerTool(
    'get_section',
    {
      title: 'Get a single section of a page',
      description:
        'Return only the markdown of one section of a page, identified by its heading anchor slug (lowercased, hyphenated). Use get_toc first to find available anchors.',
      inputSchema: {
        ref: z.string().min(1).describe('URL path, absolute URL, or slug of the page.'),
        anchor: z
          .string()
          .min(1)
          .describe('Heading anchor slug (no leading "#"). E.g. "getting-started".'),
      },
    },
    async (args) => {
      try {
        const section = await source.getSection(args.ref, args.anchor);
        return textResult(section.markdown);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- get_toc -------------------------------------------------------------
  server.registerTool(
    'get_toc',
    {
      title: 'Get a page table of contents',
      description: 'List the headings of a page with their depth and anchor slug.',
      inputSchema: {
        ref: z.string().min(1).describe('URL path, absolute URL, or slug of the page.'),
      },
    },
    async (args) => {
      try {
        const toc = await source.getToc(args.ref);
        if (toc.length === 0) return textResult('(no headings)');
        const lines = toc.map((t) => `${'  '.repeat(Math.max(0, t.depth - 1))}- ${t.title} (#${t.anchor})`);
        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- get_meta ------------------------------------------------------------
  server.registerTool(
    'get_meta',
    {
      title: 'Get page metadata',
      description: 'Return the frontmatter / metadata of a page as JSON.',
      inputSchema: {
        ref: z.string().min(1).describe('URL path, absolute URL, or slug of the page.'),
      },
    },
    async (args) => {
      try {
        const meta = await source.getMeta(args.ref);
        return textResult(JSON.stringify(meta, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- get_llms_txt --------------------------------------------------------
  server.registerTool(
    'get_llms_txt',
    {
      title: 'Get llms.txt',
      description:
        'Fetch the site\'s llms.txt (or llms-full.txt if `full: true`) if exposed. Returns null-text if the file is not available.',
      inputSchema: {
        full: z
          .boolean()
          .optional()
          .describe('If true, fetch llms-full.txt instead of llms.txt.'),
      },
    },
    async (args) => {
      try {
        const text = await source.getLlmsTxt(args.full ?? false);
        if (text == null) {
          return textResult(
            `This Fumadocs site does not expose ${args.full ? 'llms-full.txt' : 'llms.txt'}.`,
          );
        }
        return textResult(text);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  logger.info({ source: source.label }, 'fumasignal-mcp: tools registered');
}

function textResult(
  text: string,
  meta?: Record<string, unknown>,
): { content: { type: 'text'; text: string }[]; _meta?: Record<string, unknown> } {
  return {
    content: [{ type: 'text', text }],
    ...(meta ? { _meta: meta } : {}),
  };
}

function errorResult(
  err: unknown,
): { content: { type: 'text'; text: string }[]; isError: true } {
  const message =
    err instanceof NotFoundError
      ? `Not found: ${err.message}`
      : err instanceof SourceError
        ? `Source error: ${err.message}`
        : err instanceof Error
          ? `Error: ${err.message}`
          : `Error: ${String(err)}`;
  logger.warn({ err: message }, 'fumasignal-mcp: tool error');
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
