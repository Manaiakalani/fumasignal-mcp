# Contributing

Thanks for your interest! A few quick guidelines:

## Setup

```bash
npm install
npm test
npm run build
```

## Workflow

1. Open an issue first for any non-trivial change so we can align on direction.
2. Branch from `main`, write tests, keep changes focused.
3. Run `npm run typecheck && npm test` before pushing.
4. Add a changeset (`npx changeset`) describing your change — the release workflow will pick it up.

## Code style

- TypeScript strict mode, no `any` unless genuinely unavoidable.
- All logging via the `logger` helper (writes to stderr — never `console.log` in STDIO mode).
- Keep tools' responses small and focused; truncate large pages and direct users to `get_section` for deeper reads.

## Tests

- Unit tests live in `test/` next to a fixtures directory if needed.
- Use `vitest` mocks rather than network calls. The `RemoteFumadocsSource` accepts a `fetchImpl` for this reason.
