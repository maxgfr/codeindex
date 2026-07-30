// The quality RATCHET. Extraction recall/precision and search relevance are
// measured against hand-labelled ground truth (tests/quality/) and compared to
// the numbers frozen in tests/quality/baseline.json.
//
// A change that LOSES quality fails here. A change that GAINS quality also
// fails here — deliberately — until the baseline is updated in the same commit:
//
//     pnpm quality        # print the report and rewrite baseline.json
//     pnpm quality:report # print the report, touch nothing
//
// That makes every quality movement an explicit, reviewable diff of numbers
// instead of something a reader has to take on faith.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  auditTags,
  BASELINE_PATH,
  baselineOf,
  formatReport,
  languages,
  RATCHETED_METRICS,
  scoreAll,
  type LangBaseline,
  type LangReport,
} from "./quality/harness.js";
import { blindSpots, collectOracleSummaries } from "./quality/oracles.js";
import { buildQualityPayload, renderQualityJson } from "./quality/site-data.js";
import { ENGINE_VERSION } from "../src/types.js";
import {
  formatSearchReport,
  RATCHETED_SEARCH_METRICS,
  scoreSearch,
  searchBaselineOf,
  type SearchBaseline,
} from "./quality/search-harness.js";

interface Baseline {
  extraction: Record<string, LangBaseline>;
  search: SearchBaseline;
}

const WRITE = process.env.CODEINDEX_QUALITY_WRITE === "1";
const PRINT = WRITE || process.env.CODEINDEX_QUALITY_REPORT === "1";

// Reported once for the whole file: scoring every language plus the search
// corpus is a few hundred ms, and every assertion below reads these.
const reports: LangReport[] = scoreAll();
const search = scoreSearch();

function currentBaseline(): Baseline {
  const extraction: Record<string, LangBaseline> = {};
  for (const r of reports) extraction[r.lang] = baselineOf(r);
  return { extraction, search: searchBaselineOf(search) };
}

if (PRINT) {
  const lines = [
    "",
    "=== codeindex extraction quality ===",
    formatReport(reports),
    "",
    formatSearchReport(search),
    "",
  ];
  for (const r of reports) {
    const any = r.missing.length + r.spurious.length + r.wrongKind.length + r.missingDoc.length + r.missingSig.length;
    if (!any) continue;
    lines.push(`--- ${r.lang} ---`);
    for (const m of r.missing) lines.push(`  MISSING    ${m}`);
    for (const s of r.spurious) lines.push(`  SPURIOUS   ${s}`);
    for (const w of r.wrongKind) lines.push(`  WRONGKIND  ${w}`);
    for (const d of r.missingDoc) lines.push(`  NODOC      ${d}`);
    for (const g of r.missingSig) lines.push(`  BADSIG     ${g}`);
  }
  // The independent recall net: what each grammar's OWN tags.scm sees and we
  // did not. Reported, never ratcheted — see auditTags.
  const audit = auditTags();
  lines.push("", `=== tags.scm audit: ${audit.length} definition(s) the official queries see and the walk did not ===`);
  for (const a of audit) lines.push(`  ${a.lang}  ${a.file}:${a.line}  ${a.kind} ${a.name}`);

  // The independent-oracle roll-up: the checks whose authority is not ours.
  lines.push("", "=== independent oracles ===");
  for (const o of collectOracleSummaries()) lines.push(`  ${o.label.padEnd(30)} ${o.value}`);
  lines.push("", "=== blind spots (what none of the above covers) ===");
  for (const b of blindSpots()) lines.push(`  · ${b}`);
  process.stdout.write(lines.join("\n") + "\n");
}

if (WRITE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(currentBaseline(), null, 2) + "\n");
  process.stdout.write(`baseline written → ${BASELINE_PATH}\n`);

  // ONE producer for the published numbers. The site could have had its own
  // generator, and then the page and the ratchet could have disagreed about what
  // the engine scores — the exact drift tests/site-quality.test.ts exists to
  // catch. Deriving both from this run makes that impossible by construction.
  const sitePath = fileURLToPath(new URL("../site/quality.json", import.meta.url));
  writeFileSync(
    sitePath,
    renderQualityJson(
      buildQualityPayload({
        engineVersion: ENGINE_VERSION,
        extraction: currentBaseline().extraction,
        search: searchBaselineOf(search),
        searchCases: search.cases,
        searchMisses: search.misses.length,
        oracles: collectOracleSummaries(),
        blindSpots: blindSpots(),
      }),
    ),
  );
  process.stdout.write(`site payload written → ${sitePath}\n`);
}

describe("quality ratchet", () => {
  it("has a committed baseline", () => {
    expect(existsSync(BASELINE_PATH)).toBe(true);
  });

  const baseline = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline)
    : { extraction: {}, search: { mrr: 0, ndcg10: 0, recall5: 0 } };

  it("scores every labelled language", () => {
    expect(reports.map((r) => r.lang)).toEqual(languages());
    expect(reports.length).toBeGreaterThan(0);
  });

  it("every labelled language has a baseline entry", () => {
    // A new fixture directory without a baseline entry would otherwise be
    // silently unratcheted — measured but never enforced.
    for (const r of reports) expect(Object.keys(baseline.extraction)).toContain(r.lang);
  });

  describe.each(reports.map((r) => [r.lang, r] as const))("%s", (lang, report) => {
    const want = baseline.extraction[lang];
    const got = baselineOf(report);
    it.each(RATCHETED_METRICS.map((m) => [m] as const))(`%s does not regress`, (metric) => {
      if (!want) return; // covered by the "has a baseline entry" assertion above
      expect(
        got[metric],
        `${lang}.${metric}: ${got[metric]} < baseline ${want[metric]} — extraction quality regressed. ` +
          `Run \`pnpm quality:report\` for the missing/spurious symbols.`,
      ).toBeGreaterThanOrEqual(want[metric]);
    });

    it("matches the baseline exactly (update it when quality improves)", () => {
      if (!want) return;
      expect(
        got,
        `${lang} quality changed. If this is an IMPROVEMENT, run \`pnpm quality\` to refresh the baseline and commit it.`,
      ).toEqual(want);
    });
  });

  describe("search relevance", () => {
    const got = searchBaselineOf(search);
    it.each(RATCHETED_SEARCH_METRICS.map((m) => [m] as const))(`%s does not regress`, (metric) => {
      expect(
        got[metric],
        `search.${metric}: ${got[metric]} < baseline ${baseline.search[metric]} — ranking regressed.`,
      ).toBeGreaterThanOrEqual(baseline.search[metric]);
    });

    it("matches the baseline exactly (update it when relevance improves)", () => {
      expect(got, "search relevance changed. Run `pnpm quality` to refresh the baseline.").toEqual(baseline.search);
    });
  });
});
