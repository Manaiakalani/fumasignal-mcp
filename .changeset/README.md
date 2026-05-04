# Changesets

This directory holds [changesets](https://github.com/changesets/changesets) — small Markdown files describing changes that should land in the next release.

To add a changeset:

```bash
npx changeset
```

Pick the bump type (patch / minor / major) and write a one-line summary. The release workflow will then open a release PR that bumps `package.json` and updates `CHANGELOG.md`.
