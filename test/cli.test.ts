import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('reads search-path/docs-prefix/content-dir/auth-header from env vars', () => {
    process.env.FUMASIGNAL_LOCAL = '.';
    process.env.FUMASIGNAL_SEARCH_PATH = '/api/custom-search';
    process.env.FUMASIGNAL_DOCS_PREFIX = '/guide';
    process.env.FUMASIGNAL_CONTENT_DIR = 'my-docs';
    process.env.FUMASIGNAL_AUTH_HEADER = 'Bearer abc123';
    const opts = parseOptions(['node', 'cli']);
    expect(opts.searchPath).toBe('/api/custom-search');
    expect(opts.docsPrefix).toBe('/guide');
    expect(opts.contentDir).toBe('my-docs');
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
});
