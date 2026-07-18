import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOptions } from '../src/cli.js';

const ENV_KEYS = [
  'FUMASIGNAL_URL',
  'FUMASIGNAL_LOCAL',
  'FUMASIGNAL_SEARCH_PATH',
  'FUMASIGNAL_DOCS_PREFIX',
  'FUMASIGNAL_CONTENT_DIR',
  'FUMASIGNAL_AUTH_HEADER',
  'FUMASIGNAL_CACHE_TTL',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('parseOptions', () => {
  it('defaults cacheTtlMs to a real number (300000), not a string', () => {
    // Regression: Commander's .default() value is never passed through
    // argParser, so a string default ("300000") survived untouched and
    // Date.now() + ttlMs silently string-concatenated instead of adding,
    // meaning cache entries never expired on the most common invocation
    // (zero flags / zero env vars).
    const opts = parseOptions(['node', 'cli', '--local', '.']);
    expect(opts.cacheTtlMs).toBe(300_000);
    expect(typeof opts.cacheTtlMs).toBe('number');
  });

  it('reads --url/--local from FUMASIGNAL_* env vars when no flag is passed', () => {
    process.env.FUMASIGNAL_URL = 'https://example.com';
    const opts = parseOptions(['node', 'cli']);
    expect(opts.url).toBe('https://example.com');
    expect(opts.local).toBeUndefined();
  });

  it('reads --cache-ttl from FUMASIGNAL_CACHE_TTL as a validated number', () => {
    process.env.FUMASIGNAL_CACHE_TTL = '60000';
    const opts = parseOptions(['node', 'cli', '--local', '.']);
    expect(opts.cacheTtlMs).toBe(60_000);
    expect(typeof opts.cacheTtlMs).toBe('number');
  });

  it('reads remote-mode env vars (search-path/docs-prefix/auth-header) together', () => {
    process.env.FUMASIGNAL_URL = 'https://example.com';
    process.env.FUMASIGNAL_SEARCH_PATH = '/api/custom-search';
    process.env.FUMASIGNAL_DOCS_PREFIX = '/guide';
    process.env.FUMASIGNAL_AUTH_HEADER = 'Bearer abc123';
    const opts = parseOptions(['node', 'cli']);
    expect(opts.searchPath).toBe('/api/custom-search');
    expect(opts.docsPrefix).toBe('/guide');
    expect(opts.authHeader).toBe('Bearer abc123');
  });

  it('lets an explicit CLI flag take precedence over its env var', () => {
    process.env.FUMASIGNAL_CACHE_TTL = '60000';
    const opts = parseOptions(['node', 'cli', '--local', '.', '--cache-ttl', '5000']);
    expect(opts.cacheTtlMs).toBe(5000);
  });

  it('normalizes docsPrefix to a leading slash with no trailing slash', () => {
    const opts = parseOptions(['node', 'cli', '--local', '.', '--docs-prefix', 'guide/']);
    expect(opts.docsPrefix).toBe('/guide');
  });

  describe('--cache-ttl validation', () => {
    // Commander's default behavior for an argParser validation failure is
    // to print an error and call process.exit(1) (buildProgram() never
    // calls exitOverride()) - stub both so an invalid value fails this
    // test via a thrown error instead of actually terminating the worker.
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it.each(['1.5', '60s', '1e10', '-5', '', '  ', 'abc'])(
      // Regression: Number.parseInt() only reads a *leading* numeric
      // prefix and silently discards the rest of the string, so "1.5" and
      // "60s" used to be silently truncated to 1 and 60 respectively
      // instead of being rejected - a silent, wrong-by-orders-of-magnitude
      // cache TTL is exactly the kind of misconfiguration this validator
      // exists to catch.
      'rejects malformed --cache-ttl value %j instead of silently truncating it',
      (value) => {
        expect(() =>
          parseOptions(['node', 'cli', '--local', '.', '--cache-ttl', value]),
        ).toThrow();
      },
    );

    it('still accepts an ordinary value with incidental surrounding whitespace', () => {
      const opts = parseOptions(['node', 'cli', '--local', '.', '--cache-ttl', ' 5000 ']);
      expect(opts.cacheTtlMs).toBe(5000);
    });

    it('accepts 0 as a valid (caching-disabled) TTL', () => {
      const opts = parseOptions(['node', 'cli', '--local', '.', '--cache-ttl', '0']);
      expect(opts.cacheTtlMs).toBe(0);
    });
  });

  describe('--url validation', () => {
    // Same rationale as the --cache-ttl block above: buildProgram() never
    // calls exitOverride(), so an argParser rejection prints to
    // process.stderr.write (Commander's default writeErr, not console.error)
    // and calls process.exit(1) by default.
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('accepts a bare origin with no path', () => {
      const opts = parseOptions(['node', 'cli', '--url', 'https://example.com']);
      expect(opts.url).toBe('https://example.com');
    });

    it('accepts an origin with only a trailing slash', () => {
      const opts = parseOptions(['node', 'cli', '--url', 'https://example.com/']);
      expect(opts.url).toBe('https://example.com/');
    });

    it('rejects a malformed URL instead of letting it fail deep in RemoteFumadocsSource', () => {
      expect(() => parseOptions(['node', 'cli', '--url', 'not-a-url'])).toThrow();
    });

    it('rejects a non-http(s) scheme', () => {
      expect(() => parseOptions(['node', 'cli', '--url', 'ftp://example.com'])).toThrow();
    });

    // Regression: --search-path/--docs-prefix and the sitemap fetch are
    // always resolved from the URL's *origin* (see RemoteFumadocsSource),
    // so a --url with a path used to be silently accepted and then
    // silently ignored - producing a confusing 404/empty result far away
    // from the actual misconfiguration instead of an immediate, actionable
    // error pointing at --docs-prefix.
    it.each(['https://example.com/docs', 'https://example.com/docs/', 'https://example.com?q=1', 'https://example.com#frag'])(
      'rejects a --url with a path/query/fragment (%j) instead of silently discarding it',
      (value) => {
        expect(() => parseOptions(['node', 'cli', '--url', value])).toThrow();
      },
    );

    it('redacts embedded credentials in the rejected-path error message instead of leaking them to stderr', () => {
      // Regression: parseUrl()'s path/query/fragment rejection embedded
      // the raw `value` argument verbatim in its InvalidArgumentError
      // message, which Commander prints straight to stderr via
      // process.stderr.write (not console.error).
      // A --url with both a path *and* embedded "user:pass@" credentials
      // (rejected here for the path, per the tests above) used to leak
      // the credentials into that output - even though this same value
      // would go on to be safely, non-leakingly rejected again by
      // RemoteFumadocsSource's own userinfo check if it ever got that far.
      expect(() =>
        parseOptions(['node', 'cli', '--url', 'https://user:pass@example.com/some/path']),
      ).toThrow();
      const printed = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).not.toContain('pass');
      expect(printed).toContain('https://***@example.com/some/path');
    });
  });

  describe('excess positional arguments', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('rejects a stray positional argument instead of silently ignoring it', () => {
      // Regression: this program takes zero positional arguments - every
      // input is a named option - but Commander's default
      // (allowExcessArguments(true)) silently discards any bare word typed
      // on the command line (e.g. a typo'd extra path after --local),
      // giving no indication the user's intent wasn't captured anywhere.
      expect(() => parseOptions(['node', 'cli', '--local', '.', 'typo'])).toThrow();
    });

    it('still accepts zero positional arguments', () => {
      expect(() => parseOptions(['node', 'cli', '--local', '.'])).not.toThrow();
    });
  });

  describe('mutually exclusive mode flags (.conflicts())', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    // Regression: each of these remote-only/local-only flags used to be
    // silently discarded by buildSource() when combined with the "wrong"
    // mode instead of erroring - e.g. --search-path has no effect at all
    // in local mode, so a user who passed both got no feedback that their
    // flag was ignored.
    it('rejects --search-path combined with --local', () => {
      expect(() =>
        parseOptions(['node', 'cli', '--local', '.', '--search-path', '/api/search']),
      ).toThrow();
    });

    it('rejects --auth-header combined with --local', () => {
      expect(() =>
        parseOptions(['node', 'cli', '--local', '.', '--auth-header', '******']),
      ).toThrow();
    });

    it('rejects --content-dir combined with --url', () => {
      expect(() =>
        parseOptions(['node', 'cli', '--url', 'https://example.com', '--content-dir', 'docs']),
      ).toThrow();
    });

    // --cache-ttl deliberately applies to *both* modes (it's reused as the
    // local index's refresh interval in local mode - see local.ts) and
    // must NOT be treated as remote-only.
    it('accepts --cache-ttl combined with --local without conflict', () => {
      const opts = parseOptions(['node', 'cli', '--local', '.', '--cache-ttl', '1000']);
      expect(opts.cacheTtlMs).toBe(1000);
    });

    // --docs-prefix genuinely applies to both modes (it filters/resolves
    // slugs in both remote and local sources) and must stay unrestricted.
    it('accepts --docs-prefix combined with --local without conflict', () => {
      expect(() =>
        parseOptions(['node', 'cli', '--local', '.', '--docs-prefix', '/guide']),
      ).not.toThrow();
    });
  });
});
