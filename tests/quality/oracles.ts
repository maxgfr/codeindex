// The independent-oracle roll-up: one line per check whose authority comes from
// OUTSIDE this project.
//
// WHY IT MATTERS THAT THEY ARE OUTSIDE. Every extraction score in baseline.json
// is measured against ground truth this project wrote — 264 declarations, in
// fixtures the same person wrote, extracted by an engine the same person wrote.
// A construct nobody thought of is in neither the fixture nor the expectation, so
// the score stays 100% and says nothing about it. That is not a hypothetical: the
// oracles below found C headers indexing to nothing, a JS/TS walk that stopped one
// node short of every `try`/`if`/callback block, and this engine indexing its own
// doc comment as symbols.
//
// Four of the six run offline and free, so they are computed live here. The two
// that need an external binary and a cloned corpus are read from
// external-oracles.json, refreshed by the opt-in run — with their tool versions
// and corpus recorded, because a figure with no provenance is a claim, not a
// measurement.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageForAll } from "../../src/ast/grammar-coverage.js";
import { auditTags, languages } from "./harness.js";
import type { OracleSummary } from "./site-data.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTERNAL_PATH = join(HERE, "external-oracles.json");

interface ExternalOracles {
  measuredAt: string;
  tools: Record<string, string>;
  ctags: { perRepo: { repo: string; recall: number }[] };
  typescriptCompiler: { theirDeclarations: number; recall: number; unparsedSymbols: number };
  calibration: { ctagsCoverageOfCompilerDeclarations: number };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * Every oracle, as the site publishes it. Computed where free; read from the
 * committed record where it needs a tool we cannot assume is installed.
 */
export function collectOracleSummaries(): OracleSummary[] {
  const out: OracleSummary[] = [];

  // --- 1. the grammars' own declared vocabulary (offline, free) -------------
  const coverage = coverageForAll().filter((c) => c.ready);
  const uncovered = coverage.reduce((n, c) => n + c.uncoveredDeclarative.length, 0);
  out.push({
    id: "grammar-vocabulary",
    label: "Grammar vocabulary",
    authority: "each tree-sitter grammar's own declared node types, read at runtime from the parser",
    value: `${coverage.length} grammars, ${uncovered} declaration-ish types unhandled`,
    scope:
      "Names every construct a grammar declares that no extraction rule covers. The denominator is the grammar's, not ours — which is what makes it able to find what nobody thought to label.",
  });

  // --- 2. each grammar's official tags.scm (offline, free) -------------------
  const audit = auditTags();
  out.push({
    id: "official-tags-queries",
    label: "Official tags.scm queries",
    authority: "the code-navigation queries each grammar's own authors publish and maintain",
    value:
      audit.length === 0
        ? "full agreement"
        : `${audit.length} adjudicated difference${audit.length === 1 ? "" : "s"}`,
    scope:
      "Covers 14 of 17 languages: kotlin, terraform and zig publish no query, so nothing independent checks them here. The queries are also thinner than our rules, so agreement is a floor, not a ceiling.",
  });

  // --- 3 & 4. the external tools (opt-in; read from the committed record) ----
  out.push(...externalOracleSummaries());

  return out;
}

/**
 * The two oracles that need a binary we cannot assume is installed, read from
 * the committed record rather than measured here.
 *
 * Split out from collectOracleSummaries so it can be called on its own: the
 * other two load every tree-sitter grammar to compute their denominators, which
 * an environment missing the pull-only tier would silently understate. This one
 * reads a committed JSON file and nothing else, so it is reproducible anywhere.
 */
export function externalOracleSummaries(): OracleSummary[] {
  const ext = JSON.parse(readFileSync(EXTERNAL_PATH, "utf8")) as ExternalOracles;
  const byRecall = [...ext.ctags.perRepo].sort((a, b) => b.recall - a.recall);
  const best = byRecall[0]!;
  const worst = byRecall[byRecall.length - 1]!;
  return [
    {
      id: "typescript-compiler",
      label: "TypeScript compiler index",
      authority:
        "an index built by the real TypeScript compiler — authoritative where every other check here is syntactic",
      value: `${pct(ext.typescriptCompiler.recall)} of its ${ext.typescriptCompiler.theirDeclarations} declarations found`,
      scope: `Scoped to named declarations on one pinned repository, with ${ext.typescriptCompiler.unparsedSymbols} symbols left unread. It also calibrates the ctags oracle: ctags covered ${pct(ext.calibration.ctagsCoverageOfCompilerDeclarations)} of the same compiler-confirmed declarations.`,
    },
    {
      // Published as a RANGE, not a best-of. "Up to 98.8%" was true and
      // uninformative: it hid the floor, which is the number a reader weighing
      // this engine against ctags actually needs.
      id: "universal-ctags",
      label: "universal-ctags differential",
      authority: `an independent, mature indexer (${ext.tools.ctags}) covering ~40 languages`,
      value: `recall ${pct(worst.recall)}–${pct(best.recall)} over ${ext.ctags.perRepo.length} real repositories`,
      scope: `Compares declaration names per file over real code, not fixtures — highest on ${best.repo}, lowest on ${worst.repo}. ctags also reports function-body locals and quoted config keys, which a declaration index omits on purpose, so most of that spread is its surplus rather than our misses.`,
    },
  ];
}

/**
 * What none of the above can see. Published alongside the scores because a
 * report that hides its gaps is worth no more than the unqualified 100% it is
 * meant to qualify.
 */
export function blindSpots(): string[] {
  const withoutQueries = ["kotlin", "terraform", "zig"].filter((l) => languages().includes(l));
  return [
    `No published tags.scm exists for ${withoutQueries.join(", ")}, so those languages have no third-party query checking them — only the grammar-vocabulary and structural oracles.`,
    "Doc comments and full signatures cannot be checked against the external indexers at all: both report declarations only, and the persisted symbol index drops those two fields. They are covered by hand-labelled ground truth alone.",
    "The compiler-based oracle covers TypeScript on one repository. Every other language is checked by ctags, which is itself syntactic — a shared blind spot would be invisible to both.",
    "Search relevance is judged on 16 queries over one fixture service. It measures whether prose-only phrasing is findable, not general retrieval quality.",
    "One query still returns nothing relevant: asking for \"authentication\" against a file that never writes the word. No lexical index can answer that; it is what the opt-in semantic tier is for.",
  ];
}
