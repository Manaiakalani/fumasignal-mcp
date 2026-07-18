# Changelog

## 0.1.4

### Patch Changes

- 1dc3def: Harden the SSRF guard against a third IPv6 spelling that embeds a private/internal IPv4 address: the NAT64 **local-use** translation prefix `64:ff9b:1::/48` (RFC 8215), an operator-assigned alternative to the well-known prefix `64:ff9b::/96` already handled. As with the well-known prefix, a hijacked/dangling DNS record (or a synthesized `AAAA` record on an IPv6-only network fronted by a NAT64 gateway configured to use this local-use prefix) resolving to this range could otherwise slip an internal address past the check as an "ordinary" public IPv6 address. The embedded IPv4 is now validated the same way for this prefix as for the others.

## 0.1.3

### Patch Changes

- 55e0492: Harden the SSRF guard against two additional IPv6 spellings that embed a private/internal IPv4 address. Previously only the IPv4-_mapped_ form (`::ffff:a.b.c.d`) was recognized, so a hijacked/dangling DNS record (or, in an IPv6-only network fronted by NAT64/DNS64, a synthesized `AAAA` record) resolving to either of these forms could slip an internal address past the check as an "ordinary" public IPv6 address:

  - **IPv4-compatible `::/96`** (e.g. `::127.0.0.1`, which Node canonicalizes to `::7f00:1`).
  - **NAT64 well-known prefix `64:ff9b::/96`** (RFC 6052; e.g. `64:ff9b::a9fe:a9fe`, the cloud-metadata address `169.254.169.254` — translated back to that internal IPv4 at connect time on a NAT64 gateway).

  Both now have their embedded IPv4 validated the same way the mapped form already was, so a private embedded address is blocked while a public one (matching how `::ffff:8.8.8.8` is allowed) still passes.

## 0.1.2

### Patch Changes

- 002b0b9: Fit-and-finish pass covering CLI correctness, error handling, and packaging hygiene:

  - `--url` now validates that the value is an origin only (scheme + host, no path/query/hash) and fails fast with an actionable message, instead of silently discarding a path per WHATWG `URL` resolution semantics.
  - Tool errors (`search_docs`, `list_pages`, `get_page`, `get_section`, `get_toc`, `get_meta`, `get_llms_txt`) now log a structured `tool` field for easier debugging.
  - Local-mode `get_llms_txt` now correctly distinguishes "genuinely absent" (returns `null`) from "present but unreadable/oversized/symlink-escaped" (throws), matching remote-mode behavior. This also fixes a case where a symlink escaping the project root was silently indistinguishable from a missing file.
  - Remote-mode `search_docs` now wraps malformed JSON responses in a clear `SourceError` instead of an unhandled `SyntaxError`.
  - Fixed a version-drift bug where `--version` and the MCP server's reported version could disagree with `package.json`; both now import a single source of truth.
  - Disabled source maps in the published build (`tsup.config.ts`) and synced `package-lock.json`; the release workflow now keeps the lockfile in sync automatically going forward.
  - `get_meta` output is now wrapped in a fenced code block for readability; several tool descriptions and error messages were reworded for accuracy (`list_pages` limit, `get_page` truncation notice, `get_llms_txt` behavior).
  - Documentation overhaul: split the Claude Desktop / Claude Code quick-start into two correct, verified sections, fixed the Continue.dev config example, corrected the `--auth-header` example to recommend the `FUMASIGNAL_AUTH_HEADER` env var, documented all `FUMASIGNAL_*` env vars, and fixed the `npm run inspector` examples to forward `--url`/`--local`.

  No breaking changes to the MCP tool interface.

## 0.1.1

### Patch Changes

- 2097d4c: Catch-up release covering the extensive security and correctness hardening applied since the 0.1.0 initial release, including: SSRF protections (private/loopback/link-local/RFC 5737 & 3849 documentation-range blocking, DNS-rebinding guards, DNS-failure fail-closed behavior), path-traversal and symlink-escape fixes, ReDoS elimination in markdown/sitemap parsing, resource-exhaustion bounds (heading-index memory, local file size, sitemap byte accumulation, MCP tool output size, concurrent fetch limits), credential redaction in logs and cached auth headers, YAML-bomb and prototype-pollution guards in frontmatter parsing, IPv6 canonicalization fixes, and numerous edge-case corrections found across repeated multi-model security audits. No public API or MCP tool-interface changes.

## 0.1.0 — Initial release

- Remote mode: search via Fumadocs Orama API, list via sitemap, fetch pages via `.md`/`.mdx`/`/raw` or HTML→Markdown fallback, fetch `llms.txt`.
- Local mode: filesystem walk of `content/docs/**/*.{md,mdx}` with gray-matter frontmatter parsing and heading-weighted in-memory search.
- Seven MCP tools: `search_docs`, `list_pages`, `get_page`, `get_section`, `get_toc`, `get_meta`, `get_llms_txt`.
- STDIO transport, single-binary `npx -y fumasignal-mcp` install.
