import { Command, Option } from 'commander';
import { logger } from './lib/logger.js';
import { LocalFumadocsSource } from './sources/local.js';
import { RemoteFumadocsSource } from './sources/remote.js';
import type { FumadocsSource } from './sources/types.js';

export interface ParsedOptions {
  url?: string;
  local?: string;
  searchPath: string;
  docsPrefix: string;
  contentDir?: string;
  authHeader?: string;
  cacheTtlMs: number;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('fumasignal-mcp')
    .description(
      'MCP server that exposes a Fumadocs site (remote URL or local repo) to AI assistants.',
    )
    .version('0.1.0', '-v, --version')
    .option('-u, --url <url>', 'Base URL of a deployed Fumadocs site (e.g. https://fumadocs.dev).')
    .option('-l, --local <path>', 'Path to a local Fumadocs project root (filesystem mode).')
    .addOption(
      new Option('--search-path <path>', 'Path of the search API on the remote site.').default(
        '/api/search',
      ),
    )
    .addOption(
      new Option(
        '--docs-prefix <prefix>',
        'URL path prefix for documentation pages (used to filter sitemap and resolve slugs).',
      ).default('/docs'),
    )
    .addOption(
      new Option(
        '--content-dir <path>',
        'Path to the local content/docs directory (relative to --local or absolute). Default: "content/docs".',
      ),
    )
    .addOption(
      new Option(
        '--auth-header <value>',
        'Authorization header value to send on remote requests (e.g. "Bearer abc123").',
      ),
    )
    .addOption(
      new Option('--cache-ttl <ms>', 'Cache TTL for remote responses in ms.')
        .default('300000')
        .argParser((v) => Number.parseInt(v, 10)),
    );
  return program;
}

/** Read CLI args (with FUMASIGNAL_* env fallbacks) and validate. */
export function parseOptions(argv: string[]): ParsedOptions {
  const program = buildProgram();
  program.parse(argv);
  const opts = program.opts<{
    url?: string;
    local?: string;
    searchPath: string;
    docsPrefix: string;
    contentDir?: string;
    authHeader?: string;
    cacheTtl: number;
  }>();

  const url = opts.url ?? process.env.FUMASIGNAL_URL;
  const local = opts.local ?? process.env.FUMASIGNAL_LOCAL;

  if (!url && !local) {
    program.error(
      'Error: must provide --url <url> or --local <path> (or set FUMASIGNAL_URL / FUMASIGNAL_LOCAL).',
    );
  }
  if (url && local) {
    program.error('Error: --url and --local are mutually exclusive. Pick one.');
  }

  const out: ParsedOptions = {
    searchPath: opts.searchPath,
    docsPrefix: normalizePrefix(opts.docsPrefix),
    cacheTtlMs: opts.cacheTtl,
  };
  if (url) out.url = url;
  if (local) out.local = local;
  if (opts.contentDir ?? process.env.FUMASIGNAL_CONTENT_DIR) {
    out.contentDir = opts.contentDir ?? process.env.FUMASIGNAL_CONTENT_DIR;
  }
  if (opts.authHeader ?? process.env.FUMASIGNAL_AUTH_HEADER) {
    out.authHeader = opts.authHeader ?? process.env.FUMASIGNAL_AUTH_HEADER;
  }
  return out;
}

export function buildSource(opts: ParsedOptions): FumadocsSource {
  if (opts.url) {
    logger.info({ url: opts.url }, 'fumasignal-mcp: starting in remote mode');
    return new RemoteFumadocsSource({
      baseUrl: opts.url,
      searchPath: opts.searchPath,
      docsPrefix: opts.docsPrefix,
      ...(opts.authHeader ? { authHeader: opts.authHeader } : {}),
      cacheTtlMs: opts.cacheTtlMs,
    });
  }
  if (opts.local) {
    logger.info({ local: opts.local }, 'fumasignal-mcp: starting in local mode');
    return new LocalFumadocsSource({
      rootDir: opts.local,
      ...(opts.contentDir ? { contentDir: opts.contentDir } : {}),
      urlPrefix: opts.docsPrefix,
    });
  }
  throw new Error('No source configured (this is a bug).');
}

function normalizePrefix(p: string): string {
  let out = p.startsWith('/') ? p : `/${p}`;
  out = out.replace(/\/+$/, '');
  return out || '/';
}
