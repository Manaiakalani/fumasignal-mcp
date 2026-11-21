#!/usr/bin/env node
// Publish to npm only when NPM_TOKEN is present. This repo has never been
// published, and there is no NPM_TOKEN secret, so `npx changeset publish`
// fails every main push (once there are no pending changesets) with
// ENEEDAUTH. Without a token we still tag the current version so
// changesets/action can push a git tag and open a GitHub Release from
// CHANGELOG.md. `changeset tag` is idempotent: it prints "New tag:" only
// when it actually creates one, which is the line this action uses to
// decide that a GitHub Release should be opened.

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
execSync("npx changeset tag", { stdio: "inherit" });
