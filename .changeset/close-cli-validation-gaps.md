---
"fumasignal-mcp": patch
---

Close remaining CLI validation gaps and small resilience fixes found during a fit-and-finish audit:

- Reject excess positional CLI arguments instead of silently ignoring them.
- Enforce mode-appropriate flags: `--search-path`/`--auth-header` (remote-only) now conflict with `--local`; `--content-dir` (local-only) now conflicts with `--url`.
- Make `--cache-ttl` apply to both remote and local modes; local mode's in-memory index is now rebuilt on a TTL instead of being cached forever.
- Security fix: validate `--url` after parsing instead of via Commander's `argParser`, so Commander's own error wrapper can no longer re-leak a raw credentialed URL that the inner validator had already redacted.
- Trim string inputs before length validation across all MCP tool schemas.
- Surface a truncation notice when a document's heading list is capped instead of truncating silently.
- CI now runs the full `check` script (typecheck + lint + test + build) before publishing a release, not just `build`.
