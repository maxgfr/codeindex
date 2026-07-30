#!/usr/bin/env node
// Sync every JSON data island embedded in site/index.html from its source file.
//
//   node scripts/bench/sync-site.mjs           # rewrite the embedded blocks
//   node scripts/bench/sync-site.mjs --check   # exit 1 if any is out of sync (no write)
//
// The site inlines its whole dataset inside
//   <script id="<id>" type="application/json">…</script>
// blocks (zero external requests by design — see the contract in the page head
// and in .github/workflows/site.yml, which publishes site/ byte-for-byte with no
// build step). This script replaces each block's content with the EXACT bytes of
// its source JSON, so the page and the data can never drift. Idempotent.
//
// TWO islands now, which is why this loops instead of hardcoding one:
//   benchmarks-data ← site/benchmarks.json   speed / tokens / size (bench.mjs --write)
//   quality-data    ← site/quality.json      measured extraction + search quality,
//                                            WITH its denominators (pnpm quality)
//
// A source file that does not exist yet is skipped, not an error: the quality
// island is produced by `pnpm quality`, and a fresh clone should still be able to
// sync the benchmarks alone.
//
// Overrides (for tests / previews): --html <path>, and --json/--quality-json to
// point one island at a different source.
// Exit codes: 0 in sync / synced; 1 mismatch under --check, or any input error.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./repos.mjs";

const CLOSE_TAG = "</script>";

function parseArgs(argv) {
  const a = {
    check: false,
    html: join(REPO_ROOT, "site", "index.html"),
    json: join(REPO_ROOT, "site", "benchmarks.json"),
    qualityJson: join(REPO_ROOT, "site", "quality.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--check") a.check = true;
    else if (f === "--html") a.html = argv[++i];
    else if (f === "--json") a.json = argv[++i];
    else if (f === "--quality-json") a.qualityJson = argv[++i];
    else throw new Error(`unknown flag: ${f}`);
  }
  return a;
}

// Replace one island's content, returning the new html plus what happened.
// Pure on the html string so the loop below can thread several islands through
// it without re-reading the file between each.
function syncIsland(html, id, jsonPath, check) {
  const openTag = `<script id="${id}" type="application/json">`;
  const json = readFileSync(jsonPath, "utf8");

  // An embedded "</script>" would terminate the block early in the browser.
  // Data never legitimately contains it; refuse rather than corrupt.
  if (json.includes(CLOSE_TAG)) throw new Error(`${jsonPath} contains "${CLOSE_TAG}" — refusing to embed`);

  const open = html.indexOf(openTag);
  if (open < 0) throw new Error(`marker not found: ${openTag}`);
  if (html.indexOf(openTag, open + 1) >= 0) throw new Error(`marker appears more than once: ${openTag}`);
  const from = open + openTag.length;
  const to = html.indexOf(CLOSE_TAG, from);
  if (to < 0) throw new Error(`unterminated ${id} block`);

  const current = html.slice(from, to);
  if (current === json) return { html, changed: false, stale: false, bytes: Buffer.byteLength(json) };
  if (check) return { html, changed: false, stale: true, bytes: Buffer.byteLength(json), was: Buffer.byteLength(current) };
  return {
    html: html.slice(0, from) + json + html.slice(to),
    changed: true,
    stale: false,
    bytes: Buffer.byteLength(json),
    was: Buffer.byteLength(current),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let html = readFileSync(args.html, "utf8");

  const islands = [
    { id: "benchmarks-data", json: args.json },
    { id: "quality-data", json: args.qualityJson },
  ];

  let stale = 0;
  let changed = 0;
  for (const island of islands) {
    if (!existsSync(island.json)) {
      console.log(`skipped ${island.id}: ${island.json} does not exist yet`);
      continue;
    }
    const res = syncIsland(html, island.id, island.json, args.check);
    html = res.html;
    if (res.stale) {
      stale++;
      console.error(`OUT OF SYNC: ${island.id} embeds ${res.was} B, ${island.json} is ${res.bytes} B`);
    } else if (res.changed) {
      changed++;
      console.log(`synced ${island.id}: replaced ${res.was} B with ${res.bytes} B from ${island.json}`);
    } else {
      console.log(`in sync: ${island.id} already embeds ${island.json} byte-for-byte`);
    }
  }

  if (stale) {
    console.error("run `node scripts/bench/sync-site.mjs` to update site/index.html");
    return 1;
  }
  if (changed) writeFileSync(args.html, html);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`sync-site: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
