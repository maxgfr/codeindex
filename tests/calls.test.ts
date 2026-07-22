import { describe, it, expect } from "vitest";
import { resolveCallEdges } from "../src/calls.js";
import type { RepoScan } from "../src/scan.js";
import type { CodeSymbol, FileRecord } from "../src/types.js";

// Hand-built scan fixtures: resolveCallEdges only reads each file's rel/lang plus
// its `calls`/`symbols`, and the caller supplies the resolved-import pair set. We
// construct the minimum FileRecord shape rather than round-trip through a real
// scan so each edge case is isolated.
function sym(name: string, file: string, o: Partial<CodeSymbol> = {}): CodeSymbol {
  return { name, kind: o.kind ?? "function", file, line: o.line ?? 1, exported: o.exported ?? true, lang: o.lang ?? "typescript" };
}

function file(
  rel: string,
  o: { lang?: string; ext?: string; symbols?: CodeSymbol[]; calls?: { name: string; line: number }[]; importedNames?: string[] } = {},
): FileRecord {
  return {
    rel,
    ext: o.ext ?? ".ts",
    size: 0,
    lines: 1,
    hash: "h",
    kind: "code",
    lang: o.lang ?? "typescript",
    headings: [],
    symbols: o.symbols ?? [],
    refs: [],
    ...(o.calls ? { calls: o.calls } : {}),
    ...(o.importedNames ? { importedNames: o.importedNames } : {}),
  };
}

function scanOf(files: FileRecord[]): RepoScan {
  return { root: "/repo", files, languages: {}, docText: new Map(), mtimes: new Map(), capped: false };
}

describe("resolveCallEdges", () => {
  it("promotes a call to `extracted` when an import between the files corroborates it (TS)", () => {
    const scan = scanOf([
      file("src/a.ts", { calls: [{ name: "foo", line: 3 }], importedNames: ["foo"] }),
      file("src/b.ts", { symbols: [sym("foo", "src/b.ts")] }),
    ]);
    const edges = resolveCallEdges(scan, new Set(["src/a.ts|src/b.ts"]));
    expect(edges).toEqual([{ from: "src/a.ts", to: "src/b.ts", kind: "call", weight: 1, confidence: "extracted" }]);
  });

  it("drops a JS/TS bare call with no import evidence (the no-import gate)", () => {
    const scan = scanOf([
      file("src/a.ts", { calls: [{ name: "foo", line: 3 }] }),
      file("src/b.ts", { symbols: [sym("foo", "src/b.ts")] }),
    ]);
    expect(resolveCallEdges(scan, new Set())).toEqual([]);
  });

  it("resolves a unique repo-wide name to `inferred` for a non-JS/TS language without import evidence", () => {
    const scan = scanOf([
      file("pkg/a.py", { lang: "python", ext: ".py", calls: [{ name: "helper", line: 2 }] }),
      file("pkg/b.py", { lang: "python", ext: ".py", symbols: [sym("helper", "pkg/b.py", { lang: "python" })] }),
    ]);
    const edges = resolveCallEdges(scan, new Set());
    expect(edges).toEqual([{ from: "pkg/a.py", to: "pkg/b.py", kind: "call", weight: 1, confidence: "inferred" }]);
  });

  it("does not bind a call across language families", () => {
    const scan = scanOf([
      file("src/a.ts", { calls: [{ name: "Thing", line: 1 }], importedNames: ["Thing"] }),
      file("pkg/b.py", { lang: "python", ext: ".py", symbols: [sym("Thing", "pkg/b.py", { kind: "class", lang: "python" })] }),
    ]);
    expect(resolveCallEdges(scan, new Set(["src/a.ts|pkg/b.py"]))).toEqual([]);
  });

  it("binds a call across the ts↔js boundary — both fold to family js", () => {
    // Positive counterpart to the cross-family negative above: a .ts caller
    // importing + calling a function exported from a .js file resolves, because
    // familyOf collapses typescript/javascript to one "js" family.
    const scan = scanOf([
      file("src/a.ts", { calls: [{ name: "foo", line: 3 }], importedNames: ["foo"] }),
      file("src/b.js", { lang: "javascript", ext: ".js", symbols: [sym("foo", "src/b.js", { lang: "javascript" })] }),
    ]);
    const edges = resolveCallEdges(scan, new Set(["src/a.ts|src/b.js"]));
    expect(edges).toEqual([{ from: "src/a.ts", to: "src/b.js", kind: "call", weight: 1, confidence: "extracted" }]);
  });

  it("skips an ambiguous name when candidates are equally distant (no import evidence)", () => {
    const scan = scanOf([
      file("x/a.py", { lang: "python", ext: ".py", calls: [{ name: "foo", line: 1 }] }),
      file("y/b.py", { lang: "python", ext: ".py", symbols: [sym("foo", "y/b.py", { lang: "python" })] }),
      file("z/c.py", { lang: "python", ext: ".py", symbols: [sym("foo", "z/c.py", { lang: "python" })] }),
    ]);
    expect(resolveCallEdges(scan, new Set())).toEqual([]);
  });

  it("breaks a tie by path proximity — the candidate in the caller's dir wins", () => {
    const scan = scanOf([
      file("pkg/a.py", { lang: "python", ext: ".py", calls: [{ name: "foo", line: 1 }] }),
      file("pkg/b.py", { lang: "python", ext: ".py", symbols: [sym("foo", "pkg/b.py", { lang: "python" })] }),
      file("other/c.py", { lang: "python", ext: ".py", symbols: [sym("foo", "other/c.py", { lang: "python" })] }),
    ]);
    expect(resolveCallEdges(scan, new Set())).toEqual([
      { from: "pkg/a.py", to: "pkg/b.py", kind: "call", weight: 1, confidence: "inferred" },
    ]);
  });

  it("never emits a same-file call edge", () => {
    const scan = scanOf([
      file("src/a.ts", { symbols: [sym("foo", "src/a.ts")], calls: [{ name: "foo", line: 5 }] }),
    ]);
    expect(resolveCallEdges(scan, new Set())).toEqual([]);
  });

  it("caps the summed call weight at 5", () => {
    const calls = Array.from({ length: 7 }, (_, i) => ({ name: "foo", line: i + 1 }));
    const scan = scanOf([
      file("src/a.ts", { calls, importedNames: ["foo"] }),
      file("src/b.ts", { symbols: [sym("foo", "src/b.ts")] }),
    ]);
    const edges = resolveCallEdges(scan, new Set(["src/a.ts|src/b.ts"]));
    expect(edges[0]!.weight).toBe(5);
  });

  it("merges two distinct call names to one target: sums their counts and keeps extracted", () => {
    // A single python caller resolves TWO distinct names (foo×2, bar×3) to the
    // SAME target file, exercising the cross-name aggregation branch: prev.weight
    // sums to 5 (2+3, not 2 and not 3 — a lost sum would show one count) and the
    // extracted confidence is kept. NOTE: an inferred→extracted upgrade to the
    // SAME target from the SAME file is not constructible, because import evidence
    // is keyed on the file pair (from|to), so both names see the identical pair
    // and therefore share one confidence. This is the minimal shape that reaches
    // both the merge (prev.confidence = "extracted") and the count-summation lines.
    const scan = scanOf([
      file("pkg/a.py", {
        lang: "python",
        ext: ".py",
        calls: [{ name: "foo", line: 1 }, { name: "foo", line: 2 }, { name: "bar", line: 3 }, { name: "bar", line: 4 }, { name: "bar", line: 5 }],
      }),
      file("pkg/b.py", {
        lang: "python",
        ext: ".py",
        symbols: [sym("foo", "pkg/b.py", { lang: "python" }), sym("bar", "pkg/b.py", { lang: "python" })],
      }),
    ]);
    const edges = resolveCallEdges(scan, new Set(["pkg/a.py|pkg/b.py"]));
    expect(edges).toEqual([{ from: "pkg/a.py", to: "pkg/b.py", kind: "call", weight: 5, confidence: "extracted" }]);
  });

  it("keeps the strongest confidence and sorts the emitted edges", () => {
    // a.ts imports from b.ts (extracted) and c.ts is reached only by a unique
    // repo-wide match — but for JS/TS a non-imported candidate is dropped, so the
    // sort is exercised via two distinct extracted targets.
    const scan = scanOf([
      file("src/a.ts", { calls: [{ name: "foo", line: 1 }, { name: "bar", line: 2 }], importedNames: ["foo", "bar"] }),
      file("src/z.ts", { symbols: [sym("bar", "src/z.ts")] }),
      file("src/b.ts", { symbols: [sym("foo", "src/b.ts")] }),
    ]);
    const edges = resolveCallEdges(scan, new Set(["src/a.ts|src/b.ts", "src/a.ts|src/z.ts"]));
    expect(edges.map((e) => e.to)).toEqual(["src/b.ts", "src/z.ts"]);
  });
});
