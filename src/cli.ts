import { Command, InvalidArgumentError, Option } from 'commander';
import { logger, redactUrlForLogging } from './lib/logger.js';
import { VERSION } from './lib/version.js';
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

const DEFAULT_CACHE_TTL_MS = 300_000;

function parseCacheTtl(value: string): number {
  // Number.parseInt() parses only a *leading* numeric prefix and silently
  // ignores the rest of the string, so malformed operator input like
  // "1.5" (silently truncated to 1) or "60s" (silently truncated to 60, as
  // if the intended unit suffix didn't exist) would previously be accepted
  // as-is instead of rejected - a silent, wrong-by-orders-of-magnitude
  // cache TTL is exactly the kind of misconfiguration this parser exists
  // to catch. Requiring the *entire* (trimmed) string to be one or more
  // ASCII digits before converting closes that gap; Number.isFinite()
  // below still guards the remaining edge case of an absurdly long digit
  // string overflowing to Infinity.
  if (!/^\s*\d+\s*$/.test(value)) {
    throw new InvalidArgumentError('must be a non-negative integer (milliseconds).');
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError('must be a non-negative integer (milliseconds).');
  }
  return n;
}

// Deliberately NOT wired up as a Commander .argParser(): when an
// argParser throws InvalidArgumentError, Commander's own option-handling
// wraps it in `error: option '...' argument '<value>' is invalid. <msg>` -
// embedding the raw, *unredacted* CLI/env value verbatim in that outer
// wrapper regardless of how careful <msg> is about redaction. A --url
// with both a path *and* embedded "user:pass@" credentials would still
// leak the credentials via that wrapper even with a fully redacted <msg>.
// Running this as a plain post-parse check (see parseOptions() below) and
// reporting failures through program.error() directly means every
// character of the final printed message is ours to control.
function validateUrl(program: Command, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    program.error('Error: --url must be an absolute URL, e.g. "https://example.com".');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    program.error('Error: --url must use the "http" or "https" scheme.');
    return;
  }
  // --search-path and the sitemap fetch are always resolved from the
  // site's *origin* (see RemoteFumadocsSource), so any path/query/hash
  // included here is silently discarded rather than erroring - the most
  // common cause of a confusing "Search request failed: 404" or an empty
  // list_pages result is a user reasonably assuming --url's path is used
  // as-is. Reject it up front instead, pointing at the option that
  // actually exists for this: --docs-prefix.
  if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
    // Echo the redacted form, not `value` itself: see the leak this
    // function's docstring above describes - redactUrlForLogging() exists
    // to prevent exactly this everywhere else a URL is logged (see
    // logger.ts, and RemoteFumadocsSource's own userinfo rejection in
    // remote.ts).
    program.error(
      `Error: --url must be the site's origin only, with no path/query/fragment (got "${redactUrlForLogging(value)}"). ` +
        'Use --docs-prefix for a documentation path prefix, or --search-path for a non-default search API path.',
    );
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('fumasignal-mcp')
    .description(
      'MCP server that exposes a Fumadocs site (remote URL or local repo) to AI assistants.',
    )
    .version(VERSION, '-v, --version')
    // This program takes no positional arguments at all - every input is a
    // named option. Commander's default (`allowExcessArguments(true)`)
    // silently ignores anything typed as a bare positional word (e.g. a
    // stray "fumasignal-mcp --local ./docs typo"), which just as silently
    // discards whatever the user actually meant to pass. Rejecting it
    // instead surfaces the mistake immediately, consistent with this CLI's
    // existing fail-fast validation (validateUrl/parseCacheTtl above).
    .allowExcessArguments(false)
    .addOption(
      new Option(
        '-u, --url <url>',
        'Origin of a deployed Fumadocs site - scheme + host only, e.g. https://fumadocs.dev (no path; use --docs-prefix for sites that mount docs under a subpath).',
      ).env('FUMASIGNAL_URL'),
    )
    .addOption(
      new Option(
        '-l, --local <path>',
        'Path to a local Fumadocs project root (filesystem mode).',
      ).env('FUMASIGNAL_LOCAL'),
    )
    .addOption(
      new Option('--search-path <path>', 'Path of the search API on the remote site.')
        .default('/api/search')
        .env('FUMASIGNAL_SEARCH_PATH')
        // Remote-only: search_docs always calls the remote site's search
        // API. Without `.conflicts()`, passing this alongside --local (or
        // just having FUMASIGNAL_SEARCH_PATH set in the environment from an
        // unrelated remote-mode invocation) was silently discarded by
        // buildSource() with no indication the flag/env-var had no effect.
        .conflicts('local'),
    )
    .addOption(
      new Option(
        '--docs-prefix <prefix>',
        'URL path prefix for documentation pages (used to filter sitemap and resolve slugs).',
      ).default('/docs')
        .env('FUMASIGNAL_DOCS_PREFIX'),
    )
    .addOption(
      new Option(
        '--content-dir <path>',
        'Path to the local content/docs directory (relative to --local or absolute). Default: "content/docs".',
      ).env('FUMASIGNAL_CONTENT_DIR')
        // Local-only: see --search-path's .conflicts() above for why this
        // matters - --content-dir has no meaning for a remote source.
        .conflicts('url'),
    )
    .addOption(
      new Option(
        '--auth-header <value>',
        'Authorization header value to send on remote requests (e.g. "Bearer abc123").',
      ).env('FUMASIGNAL_AUTH_HEADER')
        // Remote-only: see --search-path's .conflicts() above.
        .conflicts('local'),
    )
    .addOption(
      new Option(
        '--cache-ttl <ms>',
        'Cache TTL in ms: how long remote responses are cached (remote mode), or how often the local filesystem index is refreshed to pick up doc changes (local mode).',
      )
        .default(DEFAULT_CACHE_TTL_MS)
        .argParser(parseCacheTtl)
        .env('FUMASIGNAL_CACHE_TTL'),
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

  if (!opts.url && !opts.local) {
    program.error(
      'Error: must provide --url <url> or --local <path> (or set FUMASIGNAL_URL / FUMASIGNAL_LOCAL).',
    );
  }
  if (opts.url && opts.local) {
    program.error('Error: --url and --local are mutually exclusive. Pick one.');
  }
  if (opts.url) {
    validateUrl(program, opts.url);
  }

  const out: ParsedOptions = {
    searchPath: opts.searchPath,
    docsPrefix: normalizePrefix(opts.docsPrefix),
    cacheTtlMs: opts.cacheTtl,
  };
  if (opts.url) out.url = opts.url;
  if (opts.local) out.local = opts.local;
  if (opts.contentDir) out.contentDir = opts.contentDir;
  if (opts.authHeader) out.authHeader = opts.authHeader;
  return out;
}

export function buildSource(opts: ParsedOptions): FumadocsSource {
  if (opts.url) {
    logger.info({ url: redactUrlForLogging(opts.url) }, 'fumasignal-mcp: starting in remote mode');
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
      indexTtlMs: opts.cacheTtlMs,
    });
  }
  // Unreachable in practice: parseOptions() above always calls
  // program.error() (which exits the process) unless at least one of
  // url/local is set, so this is only a defensive invariant check for a
  // caller that constructs ParsedOptions some other way (e.g. a test) -
  // not a validation message a real user should ever see.
  throw new Error(
    'buildSource() invariant violated: neither --url nor --local was set. ' +
      'This should have been rejected by parseOptions() already - please file a bug.',
  );
}

function normalizePrefix(p: string): string {
  let out = p.startsWith('/') ? p : `/${p}`;
  out = out.replace(/\/+$/, '');
  return out || '/';
}
