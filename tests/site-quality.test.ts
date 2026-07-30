import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeBase, QUALITY_SCHEMA_VERSION, type QualityPayload } from "./quality/site-data.js";

// Sibling of tests/site-benchmarks.test.ts, guarding the SECOND data island the
// page now carries.
//
// The benchmarks island already had this problem and it bit twice (see that
// file's header): the page inlines its data for the zero-external-requests
// contract, so a regenerated JSON that nobody re-synced leaves the page showing
// stale numbers, and nothing catches it — .github/workflows/site.yml publishes
// site/ byte-for-byte with no build step, so there is no deploy-time check to
// fall back on. An unguarded island would drift exactly the same way.
//
// It also pins the two things that make the QUALITY island specifically
// dangerous: the denominators must be counted from the fixtures rather than typed
// (a hardcoded "217 symbols" becomes a lie the first time a fixture is added),
// and the payload must stay timestamp-free (a `generatedAt` would make every
// rebuild a diff and dissolve the byte-equality guarantee this test exists for).

const HTML = fileURLToPath(new URL("../site/index.html", import.meta.url));
const JSON_PATH = fileURLToPath(new URL("../site/quality.json", import.meta.url));

const OPEN_TAG = '<script id="quality-data" type="application/json">';
const CLOSE_TAG = "</script>";

function embeddedBlock(html: string): string {
  const open = html.indexOf(OPEN_TAG);
  expect(open, "quality-data marker present").toBeGreaterThanOrEqual(0);
  const from = open + OPEN_TAG.length;
  const to = html.indexOf(CLOSE_TAG, from);
  expect(to, "quality-data block terminated").toBeGreaterThan(from);
  return html.slice(from, to);
}

describe("site/index.html stays a faithful view of the measured quality", () => {
  const html = readFileSync(HTML, "utf8");
  const json = readFileSync(JSON_PATH, "utf8");
  const payload = JSON.parse(json) as QualityPayload;

  it("embeds site/quality.json byte-for-byte (run `pnpm quality` then sync-site.mjs)", () => {
    expect(embeddedBlock(html)).toBe(json);
  });

  it("declares exactly one quality-data island", () => {
    // sync-site.mjs refuses to sync a duplicated marker; assert the page never
    // gets into that state in the first place.
    expect(html.indexOf(OPEN_TAG)).toBe(html.lastIndexOf(OPEN_TAG));
  });

  it("carries a schema version the page can check", () => {
    expect(payload.schemaVersion).toBe(QUALITY_SCHEMA_VERSION);
  });

  it("reports denominators that match the fixtures as they exist today", () => {
    // The whole point of publishing the base: it has to BE the base. Counted
    // fresh here and compared, so growing the corpus without regenerating the
    // payload fails instead of silently understating the evidence.
    expect(payload.base).toEqual(computeBase());
  });

  it("publishes a score for every labelled language, and a base that is not empty", () => {
    expect(payload.extraction.length).toBe(payload.base.languages);
    expect(payload.base.symbols).toBeGreaterThan(0);
    expect(payload.base.files).toBeGreaterThan(0);
  });

  it("states its blind spots — a report that hides its gaps is worth no more than a bare 100%", () => {
    expect(payload.blindSpots.length).toBeGreaterThan(0);
    for (const spot of payload.blindSpots) expect(spot.length).toBeGreaterThan(10);
  });

  it("names at least one independent oracle, with its authority and its scope", () => {
    expect(payload.oracles.length).toBeGreaterThan(0);
    for (const o of payload.oracles) {
      expect(o.id).toMatch(/^[a-z0-9-]+$/);
      expect(o.authority.length).toBeGreaterThan(10);
      expect(o.scope.length).toBeGreaterThan(10);
    }
  });

  it("carries no timestamp, so an unchanged repo re-renders byte-identically", () => {
    expect(json).not.toMatch(/generatedAt|timestamp|"date"/);
  });

  it("does not reintroduce a purged competitor into the page", () => {
    // The benchmarks guard asserts this over the whole page; assert it over the
    // quality payload too, because that is the file most likely to grow a
    // competitor name as oracles are added. The compiler-based TypeScript oracle
    // runs in CI and is reported there, deliberately not on this page.
    for (const needle of ["falcon", "scip-typescript"]) {
      expect(json.toLowerCase().includes(needle)).toBe(false);
    }
  });
});
