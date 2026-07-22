#!/usr/bin/env node
// tsup emits scripts/engine.d.ts, but consumers import the bundle as
// `./vendor/engine.mjs` — and for a `.mjs` import TypeScript only picks up a
// sibling `.d.mts` declaration. Rename so the vendored pair just works.
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const from = join(scripts, "engine.d.ts");
const to = join(scripts, "engine.d.mts");
if (existsSync(from)) {
  renameSync(from, to);
  console.log(`postbuild: ${from} -> ${to}`);
}
