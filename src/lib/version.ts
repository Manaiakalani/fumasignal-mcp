import pkg from '../../package.json' with { type: 'json' };

/**
 * Single source of truth for the package version, read directly from
 * package.json (via a build-time-resolved import, not a runtime file
 * read) rather than being hardcoded separately in the CLI's `--version`
 * flag and the MCP server's reported `version` field. Those two used to
 * be independent string literals that both said "0.1.0" and neither ever
 * got updated when changesets bumped package.json's version - so every
 * release after the first would silently misreport its own version to
 * both the terminal (`--version`) and any MCP client that inspects the
 * server's `serverInfo.version`. Importing it once here means a future
 * version bump can never cause that drift again.
 */
export const VERSION: string = pkg.version;
