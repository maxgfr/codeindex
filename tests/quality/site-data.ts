// The payload the marketing site publishes for measured quality — and, just as
// importantly, the DENOMINATORS underneath it.
//
// WHY THE DENOMINATORS ARE PART OF THE DATA. Every extraction metric in
// baseline.json currently reads 1.0. Published bare, "100%" invites exactly the
// wrong inference: that the engine is known to extract everything. What it
// actually means is narrower and worth stating — 100% of 217 declarations that
// this project labelled itself, across 16 files and 15 languages. A reader who
// can see the base can calibrate the claim; a reader shown only the score cannot.
//
// So the payload carries, side by side:
//   · the per-language scores (what the ratchet enforces),
//   · the base they are measured on (counted from the fixtures, never typed by
//     hand, so it cannot drift as fixtures grow),
//   · the independent-oracle results (scores nobody here authored),
//   · and the BLIND SPOTS — what none of the above covers.
//
// The blind-spot list is not modesty. A report that hides its gaps is worth no
// more than an unqualified 100%, and this one has real gaps: three languages have
// no published tags.scm to check them against, and the two definition-indexer
// oracles structurally cannot see signatures or doc comments.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_DIR, languages, type ExpectedSet, type LangBaseline } from "./harness.js";
import type { SearchBaseline } from "./search-harness.js";
import { byStr } from "../../src/sort.js";

/** What the labelled corpus actually contains, counted from it. */
export interface QualityBase {
  languages: number;
  files: number;
  symbols: number;
  calls: number;
  relations: number;
  /** Symbols expected to carry a doc comment / a complete signature. */
  docLabels: number;
  sigLabels: number;
}

/** One independent oracle's headline number, as published. */
export interface OracleSummary {
  /** Stable slug, e.g. "grammar-vocabulary". */
  id: string;
  label: string;
  /** What makes it independent of anything this project authored. */
  authority: string;
  /** Headline figure, already formatted for display (e.g. "97.3%", "0 gaps"). */
  value: string;
  /** Scope and honest limits of that figure. */
  scope: string;
}

export interface QualityPayload {
  /** Schema of THIS payload, so the page can refuse a shape it cannot render. */
  schemaVersion: number;
  engineVersion: string;
  base: QualityBase;
  /** Sorted by language name. */
  extraction: { lang: string; metrics: LangBaseline }[];
  search: SearchBaseline & { cases: number; misses: number };
  oracles: OracleSummary[];
  /** Plain statements of what the numbers above do NOT cover. */
  blindSpots: string[];
}

export const QUALITY_SCHEMA_VERSION = 1;

/**
 * Count the labelled corpus from the fixtures themselves. Counted, never typed:
 * a hand-written "217 symbols" on the page would silently become a lie the first
 * time someone adds a fixture.
 */
export function computeBase(): QualityBase {
  let files = 0;
  let symbols = 0;
  let calls = 0;
  let relations = 0;
  let docLabels = 0;
  let sigLabels = 0;
  const langs = languages();
  for (const lang of langs) {
    const spec = JSON.parse(readFileSync(join(FIXTURES_DIR, lang, "expected.json"), "utf8")) as ExpectedSet;
    for (const file of Object.values(spec.files)) {
      files++;
      symbols += file.symbols.length;
      calls += file.calls?.length ?? 0;
      relations += file.relations?.length ?? 0;
      for (const s of file.symbols) {
        if (s.doc) docLabels++;
        if (s.sig) sigLabels++;
      }
    }
  }
  return { languages: langs.length, files, symbols, calls, relations, docLabels, sigLabels };
}

/**
 * Assemble the published payload. `oracles` is passed in rather than computed
 * here because the external ones need tools and a corpus that are not available
 * in every environment — an absent oracle must be absent from the page, not
 * rendered as a zero that reads like a failure.
 */
export function buildQualityPayload(opts: {
  engineVersion: string;
  extraction: Record<string, LangBaseline>;
  search: SearchBaseline;
  searchCases: number;
  searchMisses: number;
  oracles: OracleSummary[];
  blindSpots: string[];
}): QualityPayload {
  return {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    engineVersion: opts.engineVersion,
    base: computeBase(),
    extraction: Object.keys(opts.extraction)
      .sort(byStr)
      .map((lang) => ({ lang, metrics: opts.extraction[lang]! })),
    search: { ...opts.search, cases: opts.searchCases, misses: opts.searchMisses },
    oracles: [...opts.oracles].sort((a, b) => byStr(a.id, b.id)),
    blindSpots: [...opts.blindSpots],
  };
}

/**
 * The page embeds these bytes verbatim (see scripts/bench/sync-site.mjs), so the
 * serialisation is part of the contract: 2-space indent + trailing newline, the
 * same shape site/benchmarks.json uses.
 *
 * Deliberately carries NO timestamp. site/benchmarks.json has `generatedAt`
 * because a benchmark is a measurement at a moment on one machine; quality is a
 * property of the committed code, so stamping it would make every rebuild a diff
 * and destroy the byte-equality guard in tests/site-quality.test.ts.
 */
export function renderQualityJson(payload: QualityPayload): string {
  return JSON.stringify(payload, null, 2) + "\n";
}
