# fumasignal-mcp

> 🚀 An MCP server that lets AI assistants search and read **any [Fumadocs](https://fumadocs.dev)** documentation site.

[![npm](https://img.shields.io/npm/v/fumasignal-mcp.svg)](https://www.npmjs.com/package/fumasignal-mcp)
[![CI](https://github.com/Manaiakalani/fumasignal-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Manaiakalani/fumasignal-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Point it at a deployed Fumadocs URL (or a local Fumadocs repo) and your AI
assistant gets seven tools to search, list, and read the docs — over the
[Model Context Protocol](https://modelcontextprotocol.io).

The name is a wink at Fumadocs author **fuma-nama** (*fuma* = 煙 = "smoke" in
Japanese) and the fact that MCP servers exist to send signals between AI
clients and external tools. Smoke signals carry messages over distance —
exactly what this server does for your docs.

> ⚠️ This is an unofficial, third-party project. Not affiliated with the
> Fumadocs project.

---

## Features

- 🔌 **Zero-setup remote mode** — give it any deployed Fumadocs URL, done.
- 💾 **Local mode** — point at a Fumadocs repo on disk for offline / pre-deploy use.
- 🔎 **7 tools**: `search_docs`, `list_pages`, `get_page`, `get_section`,
  `get_toc`, `get_meta`, `get_llms_txt`.
- 📦 **Single binary**: `npx -y fumasignal-mcp --url https://your-docs.com`.
- 🔒 **Read-only** — never mutates your docs.
- 🧪 **Well-tested** — 280+ unit tests, fixtures for the search/sitemap/HTML paths.

---

## Quick start

### Claude Desktop

Add this to your `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%/Claude/claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "fumadocs": {
      "command": "npx",
      "args": ["-y", "fumasignal-mcp", "--url", "https://fumadocs.dev"]
    }
  }
}
```

Restart Claude Desktop. You'll see seven `fumadocs__*` tools available.

### Claude Code

```bash
claude mcp add --transport stdio fumadocs -- npx -y fumasignal-mcp --url https://fumadocs.dev
```

### Cursor

In `~/.cursor/mcp.json` (or via the IDE settings):

```json
{
  "mcpServers": {
    "fumadocs": {
      "command": "npx",
      "args": ["-y", "fumasignal-mcp", "--url", "https://fumadocs.dev"]
    }
  }
}
```

### VS Code (GitHub Copilot Chat)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "fumadocs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "fumasignal-mcp", "--url", "https://fumadocs.dev"]
    }
  }
}
```

### Continue.dev

Continue reads standalone MCP configs from a `.continue/mcpServers/` folder
(create it at your workspace root, or under `~/.continue/mcpServers/` for a
global config). Simplest option — reuse the same JSON shown above for Claude
Desktop / Cursor, saved as `.continue/mcpServers/mcp.json`:

```json
{
  "mcpServers": {
    "fumadocs": {
      "command": "npx",
      "args": ["-y", "fumasignal-mcp", "--url", "https://fumadocs.dev"]
    }
  }
}
```

Or Continue's native YAML format, e.g. `.continue/mcpServers/fumadocs.yaml`:

```yaml
name: Fumadocs MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: fumadocs
    command: npx
    args: ["-y", "fumasignal-mcp", "--url", "https://fumadocs.dev"]
```

> Replace `https://fumadocs.dev` with your own Fumadocs site URL. Multiple
> sites? Run multiple instances under different keys (`fumadocs`,
> `myproduct-docs`, etc).

---

## Tools

| Tool | What it does | Required input |
|---|---|---|
| `search_docs` | Full-text search via the site's Orama API | `query` |
| `list_pages` | List all known doc pages, optionally filtered by URL prefix | _(none)_ |
| `get_page` | Fetch the full Markdown content of a page | `ref` |
| `get_section` | Get one section of a page by heading anchor | `ref`, `anchor` |
| `get_toc` | List headings (with anchors) of a page | `ref` |
| `get_meta` | Return frontmatter / page metadata as JSON | `ref` |
| `get_llms_txt` | Fetch `llms.txt` (or `llms-full.txt` if `full: true`) | _(none)_ |

`ref` accepts a URL path (`/docs/getting-started`), an absolute same-host URL,
or a slug under the docs prefix.

---

## CLI flags

```text
-u, --url <url>           Origin of a deployed Fumadocs site (scheme + host
                          only, e.g. "https://acme.com" - no path; use
                          --docs-prefix for sites that mount docs under a
                          subpath)
-l, --local <path>        Path to a local Fumadocs project root
    --search-path <path>  Search API path, resolved from the site's origin
                          root regardless of --docs-prefix (default: /api/search)
    --docs-prefix <path>  URL prefix for doc pages (default: /docs)
    --content-dir <path>  Local content/docs directory (default: content/docs)
    --auth-header <val>   Authorization header (e.g. "Bearer xxx")
    --cache-ttl <ms>      Cache TTL for remote responses (default: 300000)
-v, --version             Print version
-h, --help                Show help
```

Every flag also reads from a corresponding `FUMASIGNAL_*` env var:
`FUMASIGNAL_URL`, `FUMASIGNAL_LOCAL`, `FUMASIGNAL_SEARCH_PATH`,
`FUMASIGNAL_DOCS_PREFIX`, `FUMASIGNAL_CONTENT_DIR`, `FUMASIGNAL_AUTH_HEADER`,
`FUMASIGNAL_CACHE_TTL`. An explicit CLI flag always takes precedence over its
env var. There's also `FUMASIGNAL_LOG_LEVEL` (default: `info`; any
[pino level](https://getpino.io/#/docs/api?id=levels) works), which has no
CLI-flag equivalent.

### Examples

```bash
# Remote mode (default)
npx -y fumasignal-mcp --url https://fumadocs.dev

# Local mode (run inside or alongside your docs project)
npx -y fumasignal-mcp --local ./my-docs-site

# Custom prefixes (for sites that put docs at /handbook instead of /docs)
npx -y fumasignal-mcp --url https://acme.com --docs-prefix /handbook

# Authenticated docs site - prefer the env var over --auth-header so the
# secret doesn't linger in your shell history or show up in `ps`/process
# listings visible to other users on the machine.
FUMASIGNAL_AUTH_HEADER="<your Authorization header value>" \
  npx -y fumasignal-mcp --url https://internal.docs.acme.com
```

---

## How it works

### Remote mode

1. **Search** → calls the site's Orama search API (`/api/search` by default).
   Handles both array and `{hits:[{document}]}` response shapes.
2. **List pages** → fetches `/sitemap.xml` and filters by `--docs-prefix`.
3. **Get page** → first tries `<url>.md`, `<url>.mdx`, and `<url>/raw`.
   If none of those exist, falls back to scraping the rendered HTML and
   converting the `<article>` / `<main>` content to Markdown via
   [Turndown](https://github.com/mixmark-io/turndown).
4. **llms.txt** → fetches `/llms.txt` or `/llms-full.txt`.

Responses are cached in-memory with a default 5-minute TTL.

### Local mode

Walks `<root>/content/docs/**/*.{md,mdx}` and parses frontmatter via
[gray-matter](https://github.com/jonschlinkert/gray-matter). `index.{md,mdx}`
maps to the docs root. Search uses heading-weighted token scoring.

---

## Compatibility

- **Node.js:** 20+
- **Fumadocs:** Tested against the default Orama search API and standard sitemap
  layout. Multi-docs sites with `tag` filtering are supported via the
  `tag` argument on `search_docs`.
- **MCP clients:** Anything that speaks STDIO MCP — Claude Desktop, Claude Code,
  Cursor, VS Code (Copilot Chat / Continue), Zed, Cline, and others.

---

## Troubleshooting

**"Failed to fetch sitemap.xml"**
The site may not expose `/sitemap.xml`. You can still use `search_docs` and
`get_page`; only `list_pages` requires the sitemap.

**"Search request failed: 404"**
Pass `--search-path` if the site uses a non-default path
(e.g. `--search-path /api/v2/search`). Also check that `--url` is the
site's origin only (no path) — `/sitemap.xml` and `--search-path` are
always resolved from the origin root, not from a path in `--url`.

**HTML scrape returns junk**
Some Fumadocs sites already expose markdown via `<url>.md` — that's the
preferred path. If yours doesn't, the HTML scrape strips `nav`/`aside`/
`header`/`footer` and converts the largest `<article>` element. PRs welcome
for site-specific adapters.

**Tools don't show up in my client**
Run `npm run inspector -- --url https://fumadocs.dev` (forward your own
`--url`/`--local` after the `--`; the script builds first, then launches
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) against
`dist/index.js`) to interactively verify the server.

---

## Development

```bash
git clone https://github.com/Manaiakalani/fumasignal-mcp
cd fumasignal-mcp
npm install
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm test               # vitest
npm run build          # tsup → dist/
npm run check          # typecheck + lint + test + build, in one go
npm run inspector -- --url https://fumadocs.dev   # MCP Inspector against dist/
```

Contributions welcome — please open an issue first for non-trivial changes.

---

## License

[MIT](LICENSE) © Manaiakalani
