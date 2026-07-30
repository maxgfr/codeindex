// The ground-truth-free half of the quality suite. See tests/oracles/invariants.ts
// for WHY it exists; this file is where it becomes a gate.
//
// Everything here holds without a single label: it is checked against the source
// bytes, or against the extractor's own answer to a transformed input. So a
// violation is never "the fixture disagrees" — it is "the engine contradicts
// itself, or the file it just read". Do not relax a check to make this pass.
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeSymbol } from "../src/types.js";
import { extractCode } from "../src/extract/code.js";
import { byStr } from "../src/sort.js";
import { MAX_REEXPORTS } from "../src/lang/common.js";
import {
  checkFile,
  checkMetamorphic,
  checkRepo,
  checkSymbols,
  concatenatedSource,
  formatViolations,
  merge,
  reorderedSource,
  sortViolations,
  topLevelBlocks,
  wrappedSource,
  type InvariantReport,
  type Violation,
} from "./oracles/invariants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUALITY_DIR = join(HERE, "fixtures", "quality");
const MINI_REPO = join(HERE, "fixtures", "mini-repo");

/**
 * Every fixture SOURCE under tests/fixtures/quality (the expectation file is not
 * one).
 *
 * Deliberately NOT filtered on the presence of expected.json, unlike
 * harness.languages(): these checks need no labels, so a fixture is covered from
 * the moment it lands, before anyone has written a single expectation for it.
 */
function fixtureFiles(): { lang: string; rel: string; abs: string }[] {
  const out: { lang: string; rel: string; abs: string }[] = [];
  for (const lang of readdirSync(QUALITY_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(byStr)) {
    const dir = join(QUALITY_DIR, lang);
    for (const name of readdirSync(dir).sort(byStr)) {
      if (name === "expected.json") continue;
      out.push({ lang, rel: name, abs: join(dir, name) });
    }
  }
  return out;
}

function fail(report: InvariantReport, what: string): string {
  return `${report.violations.length} invariant violation(s) in ${what}:\n${formatViolations(report.violations)}`;
}

const FIXTURES = fixtureFiles();

describe("structural invariants over the labelled fixtures", () => {
  // Guards against the whole suite silently becoming a no-op if the fixture
  // layout moves: 15 language dirs at the time of writing.
  test("the fixture sweep is not vacuous", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(FIXTURES.map((f) => f.lang)).size).toBeGreaterThanOrEqual(15);
  });

  test.each(FIXTURES)("$lang/$rel is self-consistent", ({ rel, abs }) => {
    const report = checkFile(rel, readFileSync(abs, "utf8"));
    expect(report.symbolsChecked).toBeGreaterThan(0);
    expect(report.violations, fail(report, `${rel}`)).toEqual([]);
  });

  test("every fixture together", () => {
    const report = merge(FIXTURES.map((f) => checkFile(f.rel, readFileSync(f.abs, "utf8"))));
    expect(report.filesChecked).toBe(FIXTURES.length);
    // 217 labelled symbols is the ground-truth set; the oracle sees every symbol
    // the engine reports, labelled or not, which is the point.
    expect(report.symbolsChecked).toBeGreaterThan(200);
    expect(report.violations, fail(report, "the labelled fixtures")).toEqual([]);
  });
});

describe("metamorphic invariants over the labelled fixtures", () => {
  test.each(FIXTURES)("$lang/$rel survives its legal transforms", ({ rel, abs }) => {
    const report = checkMetamorphic(rel, readFileSync(abs, "utf8"));
    expect(report.violations, fail(report, `${rel} (metamorphic)`)).toEqual([]);
  });

  // The transforms are TypeScript-gated, so "no violations" would also be the
  // answer if they never ran at all. Pin that they DID run, on real symbols.
  test("the transforms actually ran on the TypeScript fixtures", () => {
    const ts = FIXTURES.filter((f) => f.rel.endsWith(".ts") || f.rel.endsWith(".tsx"));
    expect(ts.length).toBeGreaterThan(0);
    for (const f of ts) {
      const content = readFileSync(f.abs, "utf8");
      const report = checkMetamorphic(f.rel, content);
      expect(report.filesChecked, f.rel).toBe(1);
      expect(report.symbolsChecked, f.rel).toBeGreaterThan(0);
      // Reordering is the one transform with a precondition that can silently
      // decline (an indecomposable file — see topLevelBlocks). Pin that it does
      // not decline here, or the check would be green without ever running.
      expect(reorderedSource(content), `${f.rel} is not decomposable`).toBeDefined();
    }
  });

  test("a language the transforms are illegal for is skipped, not guessed at", () => {
    const go = FIXTURES.find((f) => f.rel.endsWith(".go"));
    expect(go).toBeDefined();
    const report = checkMetamorphic(go!.rel, readFileSync(go!.abs, "utf8"));
    // filesChecked 0 is the honest signal: `export namespace` is not Go.
    expect(report).toEqual({ filesChecked: 0, symbolsChecked: 0, violations: [] });
  });
});

describe("structural invariants over a scanned repo", () => {
  test("mini-repo is self-consistent", () => {
    const report = checkRepo(MINI_REPO);
    expect(report.filesChecked).toBeGreaterThan(0);
    expect(report.symbolsChecked).toBeGreaterThan(0);
    expect(report.violations, fail(report, "tests/fixtures/mini-repo")).toEqual([]);
  });
});

describe("the report itself", () => {
  test("two runs are deep-equal", () => {
    expect(checkRepo(MINI_REPO)).toEqual(checkRepo(MINI_REPO));
    const f = FIXTURES[0]!;
    const content = readFileSync(f.abs, "utf8");
    expect(checkFile(f.rel, content)).toEqual(checkFile(f.rel, content));
    expect(checkMetamorphic(f.rel, content)).toEqual(checkMetamorphic(f.rel, content));
  });

  test("violations come back sorted by (kind, file, symbol)", () => {
    const unsorted: Violation[] = [
      { kind: "span-missing-name", file: "b.ts", symbol: "z", detail: "2" },
      { kind: "span-missing-name", file: "a.ts", symbol: "z", detail: "1" },
      { kind: "end-before-start", file: "z.ts", symbol: "a", detail: "0" },
      { kind: "span-missing-name", file: "a.ts", symbol: "a", detail: "3" },
    ];
    expect(sortViolations(unsorted).map((v) => `${v.kind} ${v.file} ${v.symbol}`)).toEqual([
      "end-before-start z.ts a",
      "span-missing-name a.ts a",
      "span-missing-name a.ts z",
      "span-missing-name b.ts z",
    ]);
  });

  test("merge keeps the total order across files", () => {
    const merged = merge([
      { filesChecked: 1, symbolsChecked: 2, violations: [{ kind: "b", file: "f", symbol: "s", detail: "d" }] },
      { filesChecked: 1, symbolsChecked: 3, violations: [{ kind: "a", file: "f", symbol: "s", detail: "d" }] },
    ]);
    expect(merged.filesChecked).toBe(2);
    expect(merged.symbolsChecked).toBe(5);
    expect(merged.violations.map((v) => v.kind)).toEqual(["a", "b"]);
  });
});

// Each invariant, proven to FIRE. Without these the suite above could be green
// because the checks are broken rather than because the engine is right — which
// is the failure mode a green ground-truth-free gate is most exposed to.
describe("each invariant can fire", () => {
  const sym = (over: Partial<CodeSymbol> & { name: string; line: number }): CodeSymbol => ({
    kind: "function",
    file: "s.ts",
    exported: true,
    lang: "typescript",
    ...over,
  });
  const kinds = (vs: readonly Violation[]): string[] => [...new Set(vs.map((v) => v.kind))].sort(byStr);

  const SRC = ["export class Outer {", "  inner(): void {}", "}", "", "export function other(): void {}", ""].join(
    "\n",
  );

  test("span-missing-name", () => {
    const vs = checkSymbols("s.ts", SRC, [sym({ name: "notInThere", line: 1, endLine: 3 })]);
    expect(kinds(vs)).toEqual(["span-missing-name"]);
    expect(vs[0]!.detail).toContain("absent from lines 1-3");
  });

  test("span-missing-name catches a spanless symbol whose anchor line is wrong", () => {
    // No endLine: the anchor line alone must hold up. `other` is on line 5.
    expect(kinds(checkSymbols("s.ts", SRC, [sym({ name: "other", line: 1 })]))).toEqual(["span-missing-name"]);
    expect(checkSymbols("s.ts", SRC, [sym({ name: "other", line: 5 })])).toEqual([]);
  });

  test("end-before-start", () => {
    const vs = checkSymbols("s.ts", SRC, [sym({ name: "Outer", line: 3, endLine: 1 })]);
    expect(vs.map((v) => v.kind)).toContain("end-before-start");
    expect(vs.find((v) => v.kind === "end-before-start")!.detail).toBe("endLine 1 < line 3");
  });

  test("parent-not-enclosing", () => {
    const vs = checkSymbols("s.ts", SRC, [
      sym({ name: "Outer", kind: "class", line: 1, endLine: 3 }),
      sym({ name: "other", line: 5, endLine: 5, parent: "Outer" }),
    ]);
    expect(kinds(vs)).toEqual(["parent-not-enclosing"]);
    expect(vs[0]!.detail).toBe("child 5-5 outside parent Outer at 1-3");
  });

  test("parent-span-straddles", () => {
    const vs = checkSymbols("s.ts", SRC, [
      sym({ name: "Outer", kind: "class", line: 1, endLine: 3 }),
      sym({ name: "inner", line: 2, endLine: 5, parent: "Outer" }),
    ]);
    expect(kinds(vs)).toEqual(["parent-span-straddles"]);
  });

  test("duplicate-identity", () => {
    const s = sym({ name: "Outer", kind: "class", line: 1, endLine: 3 });
    // Same (file, parent, name, line), different kind — still one identity.
    expect(kinds(checkSymbols("s.ts", SRC, [s, { ...s, kind: "interface" }]))).toEqual(["duplicate-identity"]);
  });

  test("duplicate-identity does not fire on a homonym at another line", () => {
    expect(
      checkSymbols("s.ts", SRC, [
        sym({ name: "Outer", kind: "class", line: 1, endLine: 3 }),
        sym({ name: "Outer", kind: "class", line: 1, endLine: 3, parent: "other" }),
      ]),
    ).toEqual([]);
  });

  test("parent-path-inconsistent: does not end with parent", () => {
    const vs = checkSymbols("s.ts", SRC, [
      sym({ name: "inner", line: 2, endLine: 2, parent: "Outer", parentPath: "Wrong/Else" }),
    ]);
    expect(kinds(vs)).toEqual(["parent-path-inconsistent"]);
    expect(vs[0]!.detail).toContain("does not end with parent");
  });

  test("parent-path-inconsistent: no parent at all", () => {
    expect(kinds(checkSymbols("s.ts", SRC, [sym({ name: "inner", line: 2, endLine: 2, parentPath: "A/B" })]))).toEqual([
      "parent-path-inconsistent",
    ]);
  });

  test("parent-path-inconsistent: single segment only repeats parent", () => {
    const vs = checkSymbols("s.ts", SRC, [
      sym({ name: "inner", line: 2, endLine: 2, parent: "Outer", parentPath: "Outer" }),
    ]);
    expect(kinds(vs)).toEqual(["parent-path-inconsistent"]);
    expect(vs[0]!.detail).toContain('has no "/"');
  });

  test("a well-formed set produces nothing", () => {
    expect(
      checkSymbols("s.ts", SRC, [
        sym({ name: "Outer", kind: "class", line: 1, endLine: 3 }),
        sym({ name: "inner", kind: "method", line: 2, endLine: 2, parent: "Outer" }),
        sym({ name: "other", line: 5, endLine: 5 }),
      ]),
    ).toEqual([]);
  });
});

// The exemptions, pinned. Each one silences a case where the invariant CANNOT
// hold; each must stay narrow enough that the defect it resembles still fires.
describe("exemptions are narrow", () => {
  const sym = (over: Partial<CodeSymbol> & { name: string; line: number; file: string; lang: string }): CodeSymbol => ({
    kind: "function",
    exported: true,
    ...over,
  });

  test("the file-stem name of an anonymous default export is exempt", () => {
    const src = "export default function () {\n  return null;\n}\n";
    expect(
      checkSymbols("Button.tsx", src, [
        sym({ name: "Button", file: "Button.tsx", lang: "typescript", line: 1, endLine: 3 }),
      ]),
    ).toEqual([]);
  });

  test("…but the same name over a span with no `export default` still fires", () => {
    const src = "function helper(): void {}\n";
    expect(
      checkSymbols("Button.tsx", src, [
        sym({ name: "Button", file: "Button.tsx", lang: "typescript", line: 1, endLine: 1 }),
      ]).map((v) => v.kind),
    ).toEqual(["span-missing-name"]);
  });

  test("a composed name is exempt only when every segment is in the span", () => {
    const tf = 'resource "aws_instance" "worker" {\n  ami = "x"\n}\n';
    expect(
      checkSymbols("main.tf", tf, [
        sym({ name: "aws_instance.worker", kind: "resource", file: "main.tf", lang: "terraform", line: 1, endLine: 3 }),
      ]),
    ).toEqual([]);
    // One segment absent → the composite is over the wrong span, and it fires.
    expect(
      checkSymbols("main.tf", tf, [
        sym({ name: "aws_instance.absent", kind: "resource", file: "main.tf", lang: "terraform", line: 1, endLine: 3 }),
      ]).map((v) => v.kind),
    ).toEqual(["span-missing-name"]);
  });

  test("a parent absent from the file is not a violation", () => {
    // A Go method whose receiver type lives in a sibling file: there is no local
    // `Scheduler` span to compare against, so nothing is claimed.
    const src = "package p\n\nfunc (s *Scheduler) Start() error {\n\treturn nil\n}\n";
    expect(
      checkSymbols("recv.go", src, [
        sym({ name: "Start", kind: "method", file: "recv.go", lang: "go", line: 3, endLine: 5, parent: "Scheduler" }),
      ]),
    ).toEqual([]);
  });

  test("out-of-line members are exempt from enclosure but not from straddling", () => {
    const src = ["type Scheduler struct {", "\tQueue string", "}", "", "func (s *Scheduler) Start() {", "}", ""].join(
      "\n",
    );
    const parent = sym({ name: "Scheduler", kind: "struct", file: "s.go", lang: "go", line: 1, endLine: 3 });
    // Disjoint: legal Go, no violation.
    expect(
      checkSymbols("s.go", src, [
        parent,
        sym({ name: "Start", kind: "method", file: "s.go", lang: "go", line: 5, endLine: 6, parent: "Scheduler" }),
      ]),
    ).toEqual([]);
    // Half-overlapping: impossible in any language, so it still fires.
    expect(
      checkSymbols("s.go", src, [
        parent,
        sym({ name: "Queue", kind: "field", file: "s.go", lang: "go", line: 2, endLine: 6, parent: "Scheduler" }),
      ]).map((v) => v.kind),
    ).toEqual(["parent-span-straddles"]);
    // The same disjoint shape in a language that nests its members IS reported.
    expect(
      checkSymbols("s.ts", "class Scheduler {\n}\n\nfunction Start() {}\n", [
        sym({ name: "Scheduler", kind: "class", file: "s.ts", lang: "typescript", line: 1, endLine: 2 }),
        sym({ name: "Start", kind: "method", file: "s.ts", lang: "typescript", line: 4, endLine: 4, parent: "Scheduler" }),
      ]).map((v) => v.kind),
    ).toEqual(["parent-not-enclosing"]);
  });
});

// The metamorphic side has no hand-constructible positive: fabricating a lost
// symbol needs an extractor that is genuinely position-dependent, and a fake one
// would only test the fake. What CAN be pinned is that the comparison is live —
// that it sees a name set move when one really does — and that the one known
// source of a legitimate move is filtered out rather than reported.
describe("the metamorphic comparison is live", () => {
  const names = (rel: string, src: string): Set<string> =>
    new Set(extractCode(rel, rel.slice(rel.lastIndexOf(".")), src).symbols.map((s) => s.name));

  // src/lang/common.ts stops collecting barrel re-exports at MAX_REEXPORTS, so
  // which names an over-cap barrel yields depends on where they sit. This is the
  // one input whose name set provably MOVES under reordering, which is what makes
  // it a live proof that the metamorphic comparison can detect a difference at all.
  //
  // Sized FROM the constant, not from a copy of its value: this test was written
  // when the cap was 60 and silently stopped proving anything the moment the cap
  // was raised to 400 — a 70-name barrel simply stopped being capped. Deriving
  // the size means the proof survives the next change to the cap too.
  const OVER_CAP = MAX_REEXPORTS + 10;
  const BARREL = Array.from(
    { length: OVER_CAP },
    (_, i) => `export { n${String(i).padStart(4, "0")} } from "./m${i}.js";`,
  )
    .join("\n\n")
    .concat("\n");

  test("reordering an over-cap barrel does change the extracted name set", () => {
    const reordered = reorderedSource(BARREL);
    expect(reordered).toBeDefined();
    const before = names("barrel.ts", BARREL);
    const after = names("barrel.ts", reordered!);
    expect(before.size).toBe(MAX_REEXPORTS); // the cap, biting
    expect([...before].filter((n) => !after.has(n)).length).toBeGreaterThan(0);
  });

  test("…and checkMetamorphic reports nothing for it, because a cap is not a bug", () => {
    expect(checkMetamorphic("barrel.ts", BARREL)).toEqual({
      filesChecked: 0,
      symbolsChecked: 0,
      violations: [],
    });
  });

  test("wrappedSource nests the file and indents it", () => {
    const out = wrappedSource("export function a(): void {}\n");
    expect(out.split("\n")[0]).toBe("export namespace Wrapped {");
    expect(out).toContain("  export function a(): void {}");
    expect(names("w.ts", out)).toEqual(new Set(["Wrapped", "a"]));
  });

  test("concatenatedSource appends the second file whole", () => {
    const out = concatenatedSource("export const a = 1;");
    expect(names("c.ts", out)).toEqual(new Set(["a", "zzUnique"]));
  });

  test("reorderedSource refuses a source it cannot decompose", () => {
    expect(reorderedSource("export function a() {\n")).toBeUndefined();
  });
});

// The blank-line block decomposition the reorder transform permutes. A wrong
// decomposition would produce garbage source and a FALSE violation, so its
// preconditions are tested directly rather than trusted.
describe("topLevelBlocks", () => {
  test("regroups chunks split through a declaration body", () => {
    const src = ["class A {", "  x = 1;", "", "  y = 2;", "}", "", "function b() {}", ""].join("\n");
    const blocks = topLevelBlocks(src);
    expect(blocks).toBeDefined();
    expect(blocks!.length).toBe(2);
    expect(blocks![0]).toContain("class A {");
    expect(blocks![0]).toContain("y = 2;");
    expect(blocks![1]).toContain("function b()");
  });

  test("refuses an unbalanced tail rather than guessing", () => {
    expect(topLevelBlocks("function a() {\n")).toBeUndefined();
  });

  // The false positive that made the scanner string-aware: src/engine-cli.ts's
  // `HELP` is a template literal with blank lines and unpaired brackets in the
  // help text, and a naive bracket count cut it into pieces.
  test("keeps a template literal with blank lines and unpaired brackets whole", () => {
    const src = ["const HELP = `usage: x <cmd> [flags]", "", "  --out (dir}   where", "`;", "", "const N = 1;", ""].join(
      "\n",
    );
    const blocks = topLevelBlocks(src);
    expect(blocks).toBeDefined();
    expect(blocks!.length).toBe(2);
    expect(blocks![0]).toContain("--out (dir}");
    expect(blocks![1]).toContain("const N = 1;");
  });

  test("ignores brackets inside comments", () => {
    const src = ["// closes nothing: } ) ]", "const a = 1;", "", "/* nor", "   this: { ( [ */", "const b = 2;", ""].join(
      "\n",
    );
    expect(topLevelBlocks(src)?.length).toBe(2);
  });

  test("reversing the blocks is a permutation of the non-blank lines", () => {
    const src = readFileSync(join(QUALITY_DIR, "typescript", "service.ts"), "utf8");
    const blocks = topLevelBlocks(src);
    expect(blocks).toBeDefined();
    const lines = (s: string): string[] =>
      s
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .sort(byStr);
    expect(lines([...blocks!].reverse().join("\n\n"))).toEqual(lines(src));
  });
});
