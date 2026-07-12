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

const TRUNCATED_MARKER = '[truncated: front matter exceeds safety limit]';
const CIRCULAR_MARKER = '[circular reference]';

/**
 * Shared node/size budget for one `sanitizeParsedYaml()` call. Every
 * visited node (object, array, string char, or binary byte) decrements
 * `remaining` by roughly its own weight; sanitization stops expanding
 * once it hits zero. Generous enough that no real front matter (even
 * unusually large descriptions or tag lists) is affected - see
 * `sanitizeParsedYaml`'s doc comment for why this needs to be this size
 * and not, say, a simple depth limit.
 */
const MAX_FRONTMATTER_BUDGET = 200_000;

/**
 * YAML's anchor/alias feature (`&name` / `*name`) lets a single parsed
 * value be referenced from many places without duplicating it in the
 * source text - and js-yaml (which gray-matter's YAML engine uses)
 * preserves that as genuine JS object-reference sharing, not a deep
 * copy. Nesting aliases-of-aliases a handful of levels deep ("billion
 * laughs") therefore produces a JS object graph with very few *distinct*
 * objects (linear in nesting depth) that nonetheless represents an
 * astronomically large *tree* once flattened - and `JSON.stringify`
 * (used wherever `page.meta` is serialized, e.g. `get_page`'s
 * `include_meta` and `pageContentSize()`) flattens structurally, walking
 * every reference occurrence independently with no awareness of the
 * sharing. Empirically confirmed: 421 bytes of YAML using 9 levels of
 * 9-wide array aliasing parsed and `JSON.stringify`-ed to 469MB in
 * ~1.1s, a ~1,100,000x amplification, without ever throwing (unlike a
 * *true* cycle, which `JSON.stringify` itself detects and rejects).
 *
 * Memoizing repeat visits to the same shared object during sanitization
 * would NOT fix this: the output would still contain the same
 * reference-sharing shape, so a later `JSON.stringify` on the *sanitized*
 * result would still expand it exponentially. Instead, this walk
 * deliberately re-expands every occurrence (mirroring what
 * `JSON.stringify` itself would do) while tracking a shared, decrementing
 * `budget` across the *entire* call - so the moment total expansion work
 * would exceed the budget, further expansion is replaced with a short
 * marker string instead, capping the sanitized output at a small,
 * predictable size regardless of how the aliasing is shaped (deep, wide,
 * or both).
 *
 * `ancestors` (reset per top-level call, tracking the current
 * root-to-node path only) separately guards against *true* self-cycles
 * (`&a {b: *a}`), which js-yaml can also produce: without this, walking
 * into a genuine cycle would recurse forever (stack overflow) rather
 * than being caught by the budget check, since a pure cycle never
 * "bottoms out" on its own.
 */
function sanitizeNode(value: unknown, ancestors: Set<object>, budget: { remaining: number }): unknown {
  if (budget.remaining <= 0) return TRUNCATED_MARKER;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      budget.remaining -= value.length;
      if (budget.remaining < 0) {
        const keep = Math.max(0, value.length + budget.remaining);
        return keep === 0 ? TRUNCATED_MARKER : value.slice(0, keep) + '...' + TRUNCATED_MARKER;
      }
    } else {
      budget.remaining -= 1;
    }
    return value;
  }
  // Dates (from YAML `!!timestamp` scalars, common for e.g. `date:` front
  // matter fields) and binary blobs (`!!binary`) are opaque leaf values,
  // not key/value maps - walking their own enumerable properties would
  // silently lose the data (Date has none) or be pointlessly slow
  // (typed arrays). Binary length still counts against the budget since
  // it, too, can be anchored/aliased for the same amplification.
  if (value instanceof Date) {
    budget.remaining -= 1;
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    budget.remaining -= (value as { byteLength: number }).byteLength;
    return budget.remaining < 0 ? TRUNCATED_MARKER : value;
  }
  if (ancestors.has(value)) return CIRCULAR_MARKER;
  budget.remaining -= 1;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        if (budget.remaining <= 0) {
          out.push(TRUNCATED_MARKER);
          break;
        }
        out.push(sanitizeNode(item, ancestors, budget));
      }
      return out;
    }
    // Plain object (the common case) - or some other object subtype js-
    // yaml's default schema might produce (e.g. `!!set`/`!!omap`). Falling
    // back to enumerable-own-properties here fails safe for anything
    // unexpected: it can't crash or blow up, at worst it loses metadata
    // that wasn't going to be usable as a plain object anyway.
    //
    // Keys come straight from attacker-controlled YAML, so a key literally
    // named `__proto__` must not be assigned with ordinary `out[k] = v`:
    // that syntax invokes `Object.prototype`'s `__proto__` accessor setter
    // and *replaces the output object's own prototype* with the attacker's
    // value instead of creating a normal `"__proto__"` data property. The
    // result silently "shadows" unset fields (e.g. `data.locale` resolving
    // through the hijacked prototype chain to an attacker-chosen value)
    // without ever showing up in `Object.keys`/`JSON.stringify`. Using
    // `Object.defineProperty` always creates a genuine own property named
    // by the literal string key, regardless of what that string is.
    const out: Record<string, unknown> = {};
    const defineOwn = (key: string, val: unknown) =>
      Object.defineProperty(out, key, { value: val, enumerable: true, writable: true, configurable: true });
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (budget.remaining <= 0) {
        defineOwn('\u2026', TRUNCATED_MARKER);
        break;
      }
      defineOwn(k, sanitizeNode(v, ancestors, budget));
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Defuse YAML "billion laughs" amplification (and true self-cycles) in
 * already-parsed front matter data, bounding it to a small, predictable
 * size before it ever reaches a `JSON.stringify` consumer. See
 * `sanitizeNode`'s doc comment for the exact mechanics and why a simple
 * depth limit or reference-memoization wouldn't be sufficient.
 */
export function sanitizeParsedYaml(data: Record<string, unknown>): Record<string, unknown> {
  const budget = { remaining: MAX_FRONTMATTER_BUDGET };
  return sanitizeNode(data, new Set(), budget) as Record<string, unknown>;
}

/**
 * Parse Markdown front matter using gray-matter, with executable engines
 * (javascript/coffeescript) disabled. Always use this instead of calling
 * `gray-matter` directly on content that isn't fully trusted.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const parsed = matter(raw, { engines: SAFE_ENGINES });
  const data = sanitizeParsedYaml((parsed.data ?? {}) as Record<string, unknown>);
  return { content: parsed.content, data };
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
