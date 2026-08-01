#!/usr/bin/env node
// tsup emits scripts/<name>.d.ts, but consumers import the bundles as
// `./vendor/engine.mjs` (and `@maxgfr/codeindex/browser` resolves to
// engine.browser.mjs) — and for a `.mjs` import TypeScript only picks up a
// sibling `.d.mts` declaration. Rename so each pair just works.
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));

for (const name of ["engine", "engine.browser"]) {
  const from = join(scripts, `${name}.d.ts`);
  const to = join(scripts, `${name}.d.mts`);
  if (existsSync(from)) {
    renameSync(from, to);
    console.log(`postbuild: ${from} -> ${to}`);
  }
}
