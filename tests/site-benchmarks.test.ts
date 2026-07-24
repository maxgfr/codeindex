import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the two ways the marketing site (site/index.html) can silently go
// wrong, both of which actually happened and were fixed in refactor(site):
//
//   1. Data drift — the page inlines the whole report inside
//      <script id="benchmarks-data">…</script> (zero external requests by
//      design). A re-measure that rewrites site/benchmarks.json but forgets
//      `node scripts/bench/sync-site.mjs` leaves the page showing stale
//      numbers. This asserts the embedded block is byte-identical to the JSON.
//
//   2. Hardcoded column positions — the render/stat/chart code used to read
//      fixed numeric column indices (cdt[6]/cdt[7] for serena/graphify,
//      tokenRow[6] for the token ratio). When a competitor purge reordered the
//      columns those indices pointed at the wrong (or a missing) column and the
//      page rendered NaN. The code is now data-driven via a colIndex(section,
//      re) header lookup; this pins that so the fragile pattern can't return.

const HTML = fileURLToPath(new URL("../site/index.html", import.meta.url));
const JSON_PATH = fileURLToPath(new URL("../site/benchmarks.json", import.meta.url));

const OPEN_TAG = '<script id="benchmarks-data" type="application/json">';
const CLOSE_TAG = "</script>";

function embeddedBlock(html: string): string {
  const open = html.indexOf(OPEN_TAG);
  expect(open, "benchmarks-data marker present").toBeGreaterThanOrEqual(0);
  const from = open + OPEN_TAG.length;
  const to = html.indexOf(CLOSE_TAG, from);
  expect(to, "benchmarks-data block terminated").toBeGreaterThan(from);
  return html.slice(from, to);
}

/** The final inline app <script> (after the JSON data block), i.e. the render logic. */
function appScript(html: string): string {
  const start = html.lastIndexOf("<script>");
  const end = html.indexOf(CLOSE_TAG, start);
  return html.slice(start + "<script>".length, end);
}

describe("site/index.html stays a faithful, data-driven view of the benchmarks", () => {
  const html = readFileSync(HTML, "utf8");

  it("embeds site/benchmarks.json byte-for-byte (run sync-site.mjs if this fails)", () => {
    const json = readFileSync(JSON_PATH, "utf8");
    expect(embeddedBlock(html)).toBe(json);
  });

  it("carries no purged competitor anywhere in the page", () => {
    for (const needle of ["falcon", "scip-typescript"]) {
      expect(html.toLowerCase().includes(needle)).toBe(false);
    }
    expect(/\b01x\b/.test(html)).toBe(false);
  });

  it("resolves benchmark columns by header name, not fixed index", () => {
    const js = appScript(html);
    // The lookup helper is present and used.
    expect(js).toContain("function colIndex(");
    expect((js.match(/colIndex\(/g) || []).length).toBeGreaterThan(3);
    // The removed display filter must not creep back.
    for (const gone of ["HIDE_COL", "HIDE_ROW", "dropCol", "dropRow"]) {
      expect(js.includes(gone), `${gone} was removed`).toBe(false);
    }
    // None of the fragile hardcoded competitor-column indices survive.
    for (const gone of ["cdt[6]", "cdt[7]", "tokenRow[6]", "nextRow[2]", "nextRow[3]"]) {
      expect(js.includes(gone), `${gone} replaced by a colIndex lookup`).toBe(false);
    }
  });
});
