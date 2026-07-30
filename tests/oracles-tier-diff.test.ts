// The tier differential, run for real: every labelled quality fixture plus the
// mini-repo, checked with the regex tier as an oracle on the AST tier's
// hand-written tables (tests/oracles/tier-diff.ts explains why that works).
//
// The empty-`astMissing` assertions below are the point of the file. They are
// NOT a formality: each one says "on this source, the cruder tier finds nothing
// the AST tables miss". If one starts failing, the fix is to adjudicate the
// named gap — patch ast/specs.ts if it is real, or record why the regex tier
// invented it — never to loosen the assertion.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tierDiffFile, tierDiffRepo, type TierDiffReport, type TierGap } from "./oracles/tier-diff.js";
import { FIXTURES_DIR, languages } from "./quality/harness.js";
import { byStr } from "../src/sort.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MINI_REPO = join(HERE, "fixtures", "mini-repo");

interface FixtureSource {
  lang: string; // the fixture directory — the labelled language, not extToLang's label
  rel: string;
  ext: string;
  content: string;
}

// Every source file under tests/fixtures/quality/*/. `rel` is the bare basename,
// matching how tests/quality/harness.ts feeds the same files to the extractors —
// `rel` is not inert input (it decides the stem an anonymous default export is
// named after), so the two harnesses must agree on it.
function fixtureSources(): FixtureSource[] {
  const out: FixtureSource[] = [];
  for (const lang of languages()) {
    const dir = join(FIXTURES_DIR, lang);
    for (const rel of readdirSync(dir).sort(byStr)) {
      if (rel === "expected.json") continue;
      out.push({ lang, rel, ext: rel.slice(rel.lastIndexOf(".")), content: readFileSync(join(dir, rel), "utf8") });
    }
  }
  return out;
}

const SOURCES = fixtureSources();
const REPORTS = SOURCES.map((s) => ({ src: s, report: tierDiffFile(s.rel, s.ext, s.content) }));

function describeGap(g: TierGap): string {
  return `${g.lang}  ${g.file}  ${g.regexKind} ${g.name}`;
}

// The sort contract, checked structurally instead of against a frozen list — a
// new fixture must not be able to silently break ordering.
function expectSorted(report: TierDiffReport): void {
  const gapKeys = report.astMissing.map((g) => `${g.lang}\u0000${g.file}\u0000${g.name}`);
  expect(gapKeys).toEqual([...gapKeys].sort(byStr));
  const langKeys = report.byLang.map((l) => `${String(1e6 - l.astMissing).padStart(9, "0")}\u0000${l.lang}`);
  expect(langKeys).toEqual([...langKeys].sort(byStr));
  expect(report.byLang.map((l) => l.lang)).toEqual([...new Set(report.byLang.map((l) => l.lang))]);
}

describe("tier differential over the quality fixtures", () => {
  it("has fixtures to compare", () => {
    expect(SOURCES.length).toBeGreaterThan(10);
  });

  it("compares both tiers on every fixture with a grammar", () => {
    // A fixture whose grammar failed to warm would report zero gaps forever
    // while looking like a pass — so the file count is asserted, not assumed.
    // Solidity/Terraform/Zig have an AST tier but no regex extractor at all;
    // they are still checked (regexCount 0 is a real, meaningful zero).
    const checked = REPORTS.filter((r) => r.report.filesChecked === 1).map((r) => `${r.src.lang}/${r.src.rel}`);
    const skipped = REPORTS.filter((r) => r.report.filesChecked === 0).map((r) => `${r.src.lang}/${r.src.rel}`);
    expect(skipped, `no grammar loaded for: ${skipped.join(", ")}`).toEqual([]);
    expect(checked.length).toBe(SOURCES.length);
  });

  it("the AST tier misses nothing the regex tier finds", () => {
    const gaps = REPORTS.flatMap((r) => r.report.astMissing);
    expect(
      gaps.map(describeGap),
      `the regex tier found ${gaps.length} declaration(s) the AST tier did not. Adjudicate each: ` +
        `a real declaration means a hole in src/ast/specs.ts, a phantom one means a regex-tier ` +
        `false positive. Do NOT weaken this assertion.`,
    ).toEqual([]);
  });

  it("the AST tier is the richer of the two", () => {
    // The differential would also "pass" if the AST tier simply returned
    // everything the regex tier does and nothing more — i.e. if the tables had
    // quietly collapsed to line-rule parity. A large reverse gap is the evidence
    // that the two tiers really are different instruments.
    const richer = REPORTS.reduce((n, r) => n + r.report.regexMissingCount, 0);
    expect(richer).toBeGreaterThan(SOURCES.length);
  });

  it("is deterministic and sorted per fixture", () => {
    for (const { src, report } of REPORTS) {
      expect(tierDiffFile(src.rel, src.ext, src.content)).toEqual(report);
      expectSorted(report);
      expect(report.byLang.length).toBeLessThanOrEqual(1); // one file, one language
    }
  });
});

describe("tier differential over the mini-repo", () => {
  const report = tierDiffRepo(MINI_REPO);

  it("checks the repo's code files", () => {
    // The mini-repo is TypeScript + Python + Go; its docs, go.mod and tsconfig
    // are not code and must not be counted.
    expect(report.filesChecked).toBeGreaterThan(5);
    expect(report.byLang.map((l) => l.lang).sort(byStr)).toEqual(["go", "python", "typescript"]);
  });

  it("the AST tier misses nothing the regex tier finds", () => {
    expect(report.astMissing.map(describeGap), `see the per-fixture test for how to adjudicate these`).toEqual([]);
  });

  it("is deterministic and sorted", () => {
    expect(tierDiffRepo(MINI_REPO)).toEqual(report);
    expectSorted(report);
  });
});

describe("the differential can actually fire", () => {
  // Everything above asserts an EMPTY list, which an oracle that silently
  // compared nothing would also satisfy. These three cases prove the machinery
  // live, and they are the two categories a real corpus actually produces (see
  // the MEASURED note on tierDiffRepo): a regex-tier phantom, and a genuine
  // hole in the walk's descent.
  //
  // The phantom uses the regex tier's defining weakness rather than a fabricated
  // AST hole: `scan` (lang/common.ts) matches line by line with no notion of
  // comments, so a `function` inside a block comment is a declaration to it and
  // is nothing at all to tree-sitter.
  const src = [
    "export function real(): void {}",
    "/*",
    "function ghost() {}",
    "*/",
    "export class Holder {",
    "  method(): void {}",
    "}",
  ].join("\n");
  const report = tierDiffFile("holder.ts", ".ts", src);

  it("reports the regex tier's phantom declaration as a candidate gap", () => {
    expect(report.astMissing).toEqual([
      { lang: "typescript", file: "holder.ts", name: "ghost", regexKind: "function" },
    ]);
    expect(report.filesChecked).toBe(1);
  });

  it("counts the AST tier's extra structural symbol in the other direction", () => {
    // `method` is a class member: the AST walk emits it, one-regex-per-line
    // cannot. Counted, not listed — the module's stated asymmetry.
    expect(report.regexMissingCount).toBe(1);
    expect(report.byLang).toEqual([{ lang: "typescript", astCount: 3, regexCount: 3, astMissing: 1 }]);
  });

  it("no longer loses a declaration one block deeper — the hole this oracle found, now closed", () => {
    // This case used to assert a LIVE BUG. `direct` and `guarded` are the same
    // declaration one block apart, and the AST tier reported only `direct`:
    // ast/extract.ts's `walk` descends into a non-declaration node only when that
    // node's own type is in `spec.containers`, and while `statement_block` was
    // listed, `try_statement` was not — so the block it owns was unreachable.
    // Same for if/for/for-of, and for an arrow passed as a call argument.
    //
    // The differential found 91 of these in this repo alone, including every
    // closure src/ast/extract.ts is built from. The container set now lists the
    // statements that OWN a block, so the case has flipped from pinning the bug
    // to pinning the fix.
    const nested = [
      "export function outer(): void {",
      "  const direct = (): void => {};",
      "  try {",
      "    const guarded = (): void => {};",
      "    guarded();",
      "  } catch {}",
      "  direct();",
      "}",
    ].join("\n");
    expect(tierDiffFile("nested.ts", ".ts", nested).astMissing).toEqual([]);
  });

  it("reaches a declaration inside a callback passed as an argument", () => {
    // The `app.get("/x", (req, res) => { … })` shape, which the container set's
    // own comment claimed to support and did not: the chain
    // expression_statement → call_expression → arguments → arrow_function →
    // statement_block needs every link walkable, and three were missing.
    const cb = [
      "export function mount(app: App): void {",
      '  app.get("/x", (req, res) => {',
      "    function handler(): void {}",
      "    handler();",
      "  });",
      "}",
    ].join("\n");
    expect(tierDiffFile("cb.ts", ".ts", cb).astMissing).toEqual([]);
  });
});
