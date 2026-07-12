import matter from 'gray-matter';

/**
 * gray-matter supports "language-tagged" front matter fences (e.g. a file
 * starting with `---javascript` instead of plain `---`). Its default engine
 * for that language calls `eval()` on the block content, and the "coffee"
 * engine is similarly executable. That means indexing/fetching an untrusted
 * Markdown file (a symlinked/cloned docs repo, a compromised remote site,
 * etc.) could execute arbitrary code as a side effect of merely reading it.
 *
 * We only ever need declarative YAML/JSON front matter, so we explicitly
 * disable the executable engines while leaving yaml/json intact.
 */
function disabledEngine(language: string) {
  return {
    parse(): never {
      throw new Error(
        `fumasignal-mcp: front matter language "${language}" is disabled for security reasons.`,
      );
    },
  };
}

const SAFE_ENGINES = {
  javascript: disabledEngine('javascript'),
  js: disabledEngine('javascript'),
  coffee: disabledEngine('coffeescript'),
  coffeescript: disabledEngine('coffeescript'),
  cson: disabledEngine('coffeescript'),
};

export interface ParsedFrontmatter {
  content: string;
  data: Record<string, unknown>;
}

/**
 * Parse Markdown front matter using gray-matter, with executable engines
 * (javascript/coffeescript) disabled. Always use this instead of calling
 * `gray-matter` directly on content that isn't fully trusted.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const parsed = matter(raw, { engines: SAFE_ENGINES });
  return { content: parsed.content, data: (parsed.data ?? {}) as Record<string, unknown> };
}

/**
 * Frontmatter (and, more generally, any untrusted parsed YAML/JSON) values
 * may not be the type a caller expects - e.g. `title: 42` or `title: true`
 * parse as a number or boolean, not a string. Use this instead of an `as
 * string` cast when reading a field that should be a non-empty string, so
 * a wrong-typed value falls through to `undefined` (letting the caller's
 * own fallback chain handle it) rather than silently propagating a
 * non-string into a `string`-typed field. Also useful for parsing
 * loosely-typed external JSON, e.g. a remote search API's response.
 */
export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
