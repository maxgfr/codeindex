#!/usr/bin/env node
// Sync the benchmarks JSON embedded in site/index.html from site/benchmarks.json.
//
//   node scripts/bench/sync-site.mjs           # rewrite the embedded block
//   node scripts/bench/sync-site.mjs --check   # exit 1 if out of sync (no write)
//
// The site inlines the whole report inside
//   <script id="benchmarks-data" type="application/json">…</script>
// (zero external requests by design). This script replaces that block's content
// with the EXACT bytes of site/benchmarks.json — the file bench.mjs --write
// produces — so the page and the JSON can never drift. Idempotent: a second run
// finds the content identical and writes nothing.
//
// Overrides (for tests / previews): --html <path> --json <path>.
// Exit codes: 0 in sync / synced; 1 mismatch under --check, or any input error.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./repos.mjs";

const OPEN_TAG = '<script id="benchmarks-data" type="application/json">';
const CLOSE_TAG = "</script>";

function parseArgs(argv) {
  const a = {
    check: false,
    html: join(REPO_ROOT, "site", "index.html"),
    json: join(REPO_ROOT, "site", "benchmarks.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--check") a.check = true;
    else if (f === "--html") a.html = argv[++i];
    else if (f === "--json") a.json = argv[++i];
    else throw new Error(`unknown flag: ${f}`);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const html = readFileSync(args.html, "utf8");
  const json = readFileSync(args.json, "utf8");

  // An embedded "</script>" would terminate the block early in the browser.
  // Benchmark data never legitimately contains it; refuse rather than corrupt.
  if (json.includes(CLOSE_TAG)) throw new Error(`${args.json} contains "${CLOSE_TAG}" — refusing to embed`);

  const open = html.indexOf(OPEN_TAG);
  if (open < 0) throw new Error(`marker not found in ${args.html}: ${OPEN_TAG}`);
  if (html.indexOf(OPEN_TAG, open + 1) >= 0) throw new Error(`marker appears more than once in ${args.html}`);
  const from = open + OPEN_TAG.length;
  const to = html.indexOf(CLOSE_TAG, from);
  if (to < 0) throw new Error(`unterminated benchmarks-data block in ${args.html}`);

  const current = html.slice(from, to);
  if (current === json) {
    console.log(`in sync: ${args.html} already embeds ${args.json} byte-for-byte`);
    return 0;
  }
  if (args.check) {
    console.error(`OUT OF SYNC: embedded block (${Buffer.byteLength(current)} B) != ${args.json} (${Buffer.byteLength(json)} B)`);
    console.error("run `node scripts/bench/sync-site.mjs` to update site/index.html");
    return 1;
  }
  writeFileSync(args.html, html.slice(0, from) + json + html.slice(to));
  console.log(`synced: replaced ${Buffer.byteLength(current)} B embedded block with ${Buffer.byteLength(json)} B from ${args.json}`);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`sync-site: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
