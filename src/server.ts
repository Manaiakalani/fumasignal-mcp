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

/**
 * Hard ceiling on the text of any single tool result, enforced centrally
 * in `textResult()`/`errorResult()` - the two functions every tool routes
 * its output through - rather than in each tool individually, so new
 * tools automatically inherit it. `MAX_PAGE_CHARS` already truncates
 * `get_page`'s markdown body specifically, but every other tool -
 * `get_toc`, `get_meta`, `get_section`, `list_pages`, `search_docs` - has
 * no size cap of its own: their output is bounded only by the underlying
 * page's `maxResponseBytes`/`maxFileBytes` cap (10MB by default), which is
 * far larger than a reasonable MCP tool response. The content driving
 * these tools is untrusted (same threat model as everywhere else in this
 * codebase - see net-safety.ts, local.ts, remote.ts): a single crafted
 * page - a huge HTML `<title>`, thousands of headings, a giant
 * frontmatter block, or one section spanning the whole body (defeating
 * `get_page`'s own truncation, since `get_section` has none) - could
 * otherwise produce a multi-MB tool response, and concurrent calls
 * multiply that cost. Set well above `MAX_PAGE_CHARS` so it never
 * interferes with that tool's own, more specific truncation notice -
 * this is a last-resort safety net for everything else, not a
 * replacement for it.
 */
const MAX_TOOL_RESULT_CHARS = 200_000;

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
        query: z.string().min(1).max(500).describe('Search query.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe('Max results to return (default 10, max 50).'),
        tag: z
          .string()
          .max(100)
          .optional()
          .describe('Optional tag filter (used by Fumadocs multi-docs sites).'),
        locale: z.string().max(100).optional().describe('Optional locale filter (e.g. "en", "cn").'),
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
          .max(500)
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
          .max(2000)
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
          const cut = safeTruncateLength(body, MAX_PAGE_CHARS);
          body = `${body.slice(0, cut)}\n\n…[truncated; ${body.length - cut} more chars available via get_section]`;
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
        ref: z.string().min(1).max(2000).describe('URL path, absolute URL, or slug of the page.'),
        anchor: z
          .string()
          .min(1)
          .max(200)
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
        ref: z.string().min(1).max(2000).describe('URL path, absolute URL, or slug of the page.'),
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
        ref: z.string().min(1).max(2000).describe('URL path, absolute URL, or slug of the page.'),
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
  const [out, cappedHere] = capToolResultChars(text);
  return {
    content: [{ type: 'text', text: out }],
    ...(meta || cappedHere ? { _meta: { ...meta, ...(cappedHere ? { truncated: true } : {}) } } : {}),
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
  const [out] = capToolResultChars(message);
  return {
    content: [{ type: 'text', text: out }],
    isError: true,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, safeTruncateLength(s, max))}…`;
}

/**
 * Return a cut length `<= max` such that `text.slice(0, cut)` never splits
 * a UTF-16 surrogate pair. Strings are sequences of UTF-16 code units, not
 * code points: an emoji or other supplementary-plane character is stored
 * as a high surrogate (0xD800-0xDBFF) followed by a low surrogate, and
 * naively cutting at an arbitrary offset can land between the two. That
 * leaves a dangling lone high surrogate at the end of the truncated
 * string, which is not well-formed Unicode and can render as U+FFFD or
 * confuse a downstream JSON/UTF-8 encoder. Used by every truncation site
 * in this file so none of them can reintroduce this.
 */
function safeTruncateLength(text: string, max: number): number {
  if (max <= 0 || max >= text.length) return Math.max(0, Math.min(max, text.length));
  const before = text.charCodeAt(max - 1);
  return before >= 0xd800 && before <= 0xdbff ? max - 1 : max;
}

/**
 * Last-resort safety net applied to every tool result (success or error) -
 * see `MAX_TOOL_RESULT_CHARS`'s doc comment for why this exists as a
 * central check rather than relying on each tool to bound its own output.
 * Returns the (possibly truncated) text plus whether truncation happened
 * *here* specifically, so callers can merge that into their own
 * truncation flag without clobbering one a tool already set for its own,
 * more specific reason (e.g. get_page's MAX_PAGE_CHARS notice).
 */
function capToolResultChars(text: string): [string, boolean] {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return [text, false];
  const cut = safeTruncateLength(text, MAX_TOOL_RESULT_CHARS);
  const out = `${text.slice(0, cut)}\n\n…[response truncated at ${MAX_TOOL_RESULT_CHARS} characters; use a more targeted tool or a smaller limit/prefix to retrieve less at once]`;
  return [out, true];
}
