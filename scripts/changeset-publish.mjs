#!/usr/bin/env node
// Publish to npm only when NPM_TOKEN is present. This repo has never been
// published, and there is no NPM_TOKEN secret, so `npx changeset publish`
// fails every main push (once there are no pending changesets) with
// ENEEDAUTH. Without a token we still tag the current version so
// changesets/action can push a git tag and open a GitHub Release from
// CHANGELOG.md.
//
// changesets/action v2 no longer parses "New tag:" from stdout. It sets
// CHANGESETS_OUTPUT to an NDJSON file and reads `git-tag` events from it.
// Inherit that env var when invoking the CLI. `changeset git-tag` is the
// v3 name of the old `changeset tag` command; it is idempotent and only
// emits a git-tag event when it actually creates a tag.

import { execSync } from "node:child_process";

const npmToken = process.env.NPM_TOKEN?.trim() ?? "";

if (npmToken) {
  execSync("npx changeset publish", {
    stdio: "inherit",
    env: {
      ...process.env,
      NPM_TOKEN: npmToken,
      NODE_AUTH_TOKEN: npmToken,
    },
  });
  process.exit(0);
}

console.log(
  "NPM_TOKEN is not set; skipping npm publish and tagging the current version instead.",
);
execSync("npx changeset git-tag", {
  stdio: "inherit",
  env: process.env,
});
