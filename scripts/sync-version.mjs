#!/usr/bin/env node
// Sync the release version across every place it lives, then let the caller
// rebuild the bundle. Invoked by @semantic-release/exec (prepareCmd):
//   node scripts/sync-version.mjs <version>
//
// The version is duplicated in package.json and src/types.ts (the ENGINE_VERSION
// the bundle embeds — consumers' sync scripts grep it to verify a vendored copy
// matches its pinned tag). CHANGELOG.md is owned by @semantic-release/changelog.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  console.error(`sync-version: expected a semver version, got "${version ?? ""}"`);
  process.exit(1);
}

function edit(path, transform) {
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) {
    console.error(`sync-version: WARNING — no change applied to ${path}`);
  }
  writeFileSync(path, after);
}

edit("package.json", (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
edit("src/types.ts", (s) => s.replace(/(export const ENGINE_VERSION = ")[^"]+(";)/, `$1${version}$2`));

console.log(`sync-version: set ${version} in package.json, src/types.ts`);
