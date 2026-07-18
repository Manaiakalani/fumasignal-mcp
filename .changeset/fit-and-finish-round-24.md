---
"fumasignal-mcp": patch
---

Fit-and-finish pass covering CLI correctness, error handling, and packaging hygiene:

- `--url` now validates that the value is an origin only (scheme + host, no path/query/hash) and fails fast with an actionable message, instead of silently discarding a path per WHATWG `URL` resolution semantics.
- Tool errors (`search_docs`, `list_pages`, `get_page`, `get_section`, `get_toc`, `get_meta`, `get_llms_txt`) now log a structured `tool` field for easier debugging.
- Local-mode `get_llms_txt` now correctly distinguishes "genuinely absent" (returns `null`) from "present but unreadable/oversized/symlink-escaped" (throws), matching remote-mode behavior. This also fixes a case where a symlink escaping the project root was silently indistinguishable from a missing file.
- Remote-mode `search_docs` now wraps malformed JSON responses in a clear `SourceError` instead of an unhandled `SyntaxError`.
- Fixed a version-drift bug where `--version` and the MCP server's reported version could disagree with `package.json`; both now import a single source of truth.
- Disabled source maps in the published build (`tsup.config.ts`) and synced `package-lock.json`; the release workflow now keeps the lockfile in sync automatically going forward.
- `get_meta` output is now wrapped in a fenced code block for readability; several tool descriptions and error messages were reworded for accuracy (`list_pages` limit, `get_page` truncation notice, `get_llms_txt` behavior).
- Documentation overhaul: split the Claude Desktop / Claude Code quick-start into two correct, verified sections, fixed the Continue.dev config example, corrected the `--auth-header` example to recommend the `FUMASIGNAL_AUTH_HEADER` env var, documented all `FUMASIGNAL_*` env vars, and fixed the `npm run inspector` examples to forward `--url`/`--local`.

No breaking changes to the MCP tool interface.
