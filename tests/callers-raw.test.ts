import { describe, expect, it } from "vitest";
import { buildCallerIndex, buildRawCallerIndex, enclosingSymbol } from "../src/callers.js";
import type { RepoScan } from "../src/scan.js";
import type { CodeSymbol, FileRecord } from "../src/types.js";

// Hand-built scans (calls.test.ts / callers-recall.test.ts style): minimal
// FileRecords isolate exactly the raw-recall behavior under test, with no
// dependency on real extraction.
function sym(name: string, file: string, o: Partial<CodeSymbol> = {}): CodeSymbol {
  return {
    name,
    kind: o.kind ?? "function",
    file,
    line: o.line ?? 1,
    endLine: o.endLine,
    exported: o.exported ?? true,
    lang: o.lang ?? "typescript",
  };
}

function file(
  rel: string,
  o: {
    lang?: string;
    ext?: string;
    symbols?: CodeSymbol[];
    calls?: { name: string; line: number; receiver?: string }[];
  } = {},
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
  };
}

function scanOf(files: FileRecord[]): RepoScan {
  return { root: "/repo", files, languages: {}, docText: new Map(), mtimes: new Map(), capped: false, excluded: 0, contentUnchanged: false, cacheDirty: true };
}

// A scan exercising every case buildCallerIndex (def-resolved) drops on the
// floor: an unresolvable name, a same-name ambiguity (2 defs, no import
// evidence), and a call at the exact same (file, line) as its own same-file
// declaration (the self-declaration-line skip). Also carries the one call
// buildCallerIndex DOES resolve (same-file shadowing), so the two functions
// can be compared side by side on identical input.
function mixedScan(): RepoScan {
  return scanOf([
    file("src/a.ts", {
      symbols: [sym("bar", "src/a.ts", { line: 5, exported: false }), sym("self", "src/a.ts", { line: 10, exported: false })],
      calls: [
        { name: "ghost", line: 1 }, // resolves to no definition anywhere
        { name: "dup", line: 2 }, // ambiguous: 2 defs (src/b.ts, src/c.ts), no import
        { name: "bar", line: 6 }, // same-file shadowed call — def-resolved binds it
        { name: "self", line: 10 }, // same line as its own declaration — def-resolved skips it
      ],
    }),
    file("src/b.ts", { symbols: [sym("dup", "src/b.ts")] }),
    file("src/c.ts", { symbols: [sym("dup", "src/c.ts")] }),
  ]);
}

describe("buildRawCallerIndex (issue #8)", () => {
  it("records every call site regardless of resolution: unresolved, ambiguous, shadowed, and self-declaration-line", () => {
    const index = buildRawCallerIndex(mixedScan());
    expect(index.get("ghost")).toEqual([{ file: "src/a.ts", line: 1 }]);
    expect(index.get("dup")).toEqual([{ file: "src/a.ts", line: 2 }]);
    expect(index.get("bar")).toEqual([
      { file: "src/a.ts", line: 6, enclosingSymbol: sym("bar", "src/a.ts", { line: 5, exported: false }) },
    ]);
    expect(index.get("self")).toEqual([
      { file: "src/a.ts", line: 10, enclosingSymbol: sym("self", "src/a.ts", { line: 10, exported: false }) },
    ]);
  });

  it("keys on the raw unqualified callee name, never a name@file qualifier", () => {
    // Family-disjoint homonyms (JS + Python) are exactly the case that forces
    // buildCallerIndex to mint a "name@file" second key. Raw recall has no
    // notion of a def file at all, so both sites collapse under one flat key.
    const scan = scanOf([
      file("src/x.ts", { calls: [{ name: "run", line: 1 }] }),
      file("pkg/y.py", { lang: "python", ext: ".py", calls: [{ name: "run", line: 2 }] }),
    ]);
    const index = buildRawCallerIndex(scan);
    expect([...index.keys()]).toEqual(["run"]);
    expect(index.get("run")).toEqual([
      { file: "pkg/y.py", line: 2 },
      { file: "src/x.ts", line: 1 },
    ]);
  });

  it("propagates receiver when present, omits it otherwise", () => {
    const scan = scanOf([
      file("src/f.ts", {
        calls: [
          { name: "get", line: 3, receiver: "axios" },
          { name: "run", line: 4 },
        ],
      }),
    ]);
    const index = buildRawCallerIndex(scan);
    expect(index.get("get")).toEqual([{ file: "src/f.ts", line: 3, receiver: "axios" }]);
    expect(index.get("run")).toEqual([{ file: "src/f.ts", line: 4 }]);
  });

  it("sorts each entry's sites by (file, line), independent of scan/file-record order", () => {
    const scan = scanOf([
      file("src/z.ts", {
        calls: [
          { name: "shared", line: 9 },
          { name: "shared", line: 2 },
        ],
      }),
      file("src/a.ts", { calls: [{ name: "shared", line: 5 }] }),
    ]);
    const index = buildRawCallerIndex(scan);
    expect(index.get("shared")).toEqual([
      { file: "src/a.ts", line: 5 },
      { file: "src/z.ts", line: 2 },
      { file: "src/z.ts", line: 9 },
    ]);
  });

  describe("enclosingSymbol per site", () => {
    // outer(1-20) wraps inner(5-10): innermost wins when both cover the line.
    // regexHelper(30)/regexHelper2(33) carry no endLine (regex-tier records),
    // so they fall back to nearest-preceding — mirroring the standalone
    // enclosingSymbol() helper's documented approximation.
    const scan = scanOf([
      file("src/e.ts", {
        symbols: [
          sym("outer", "src/e.ts", { line: 1, endLine: 20 }),
          sym("inner", "src/e.ts", { line: 5, endLine: 10 }),
          sym("regexHelper", "src/e.ts", { line: 30 }),
          sym("regexHelper2", "src/e.ts", { line: 33 }),
        ],
        calls: [
          { name: "innerCall", line: 7 }, // inside both outer and inner -> innermost = inner
          { name: "outerCall", line: 15 }, // inside outer only (past inner's endLine)
          { name: "orphanCall", line: 25 }, // past every AST extent, before any regex decl -> undefined
          { name: "regexCall", line: 35 }, // past both regex decls' start, neither bounded -> nearest-preceding wins
        ],
      }),
    ]);
    const index = buildRawCallerIndex(scan);

    it("picks the innermost AST-bounded symbol when nested", () => {
      expect(index.get("innerCall")![0]!.enclosingSymbol).toEqual(sym("inner", "src/e.ts", { line: 5, endLine: 10 }));
    });

    it("picks the enclosing AST-bounded symbol when not nested", () => {
      expect(index.get("outerCall")![0]!.enclosingSymbol).toEqual(sym("outer", "src/e.ts", { line: 1, endLine: 20 }));
    });

    it("leaves enclosingSymbol undefined outside every known extent", () => {
      expect(index.get("orphanCall")![0]!.enclosingSymbol).toBeUndefined();
      expect(index.get("orphanCall")![0]).toEqual({ file: "src/e.ts", line: 25 });
    });

    it("falls back to the nearest-preceding declaration when it carries no endLine (regex tier)", () => {
      expect(index.get("regexCall")![0]!.enclosingSymbol).toEqual(sym("regexHelper2", "src/e.ts", { line: 33 }));
    });

    it("matches the standalone enclosingSymbol() helper site-by-site", () => {
      for (const [, sites] of index) {
        for (const site of sites) {
          expect(site.enclosingSymbol).toEqual(enclosingSymbol(scan, site.file, site.line));
        }
      }
    });
  });
});

describe("enclosingSymbol tie-break (issue #12)", () => {
  // CHARACTERIZATION of the innermost-search tie-break, not a spec: when two
  // symbols share the same line AND endLine, the `<=` in enclosingAmong's
  // comparison (src/callers.ts) lets every later candidate displace the
  // earlier one, so the later-iterated symbol wins. Extraction order is
  // deterministic, so the output is reproducible as-is; flipping the
  // tie-break (e.g. to `<`, first-wins) would churn consumer-visible output
  // for no gain. This test pins the current behavior so any such change is a
  // deliberate one.
  it("when two symbols share line and endLine, the later-iterated one wins", () => {
    const scan = scanOf([
      file("src/twin.ts", {
        symbols: [
          sym("firstTwin", "src/twin.ts", { line: 3, endLine: 9 }),
          sym("secondTwin", "src/twin.ts", { line: 3, endLine: 9 }),
        ],
      }),
    ]);
    expect(enclosingSymbol(scan, "src/twin.ts", 5)!.name).toBe("secondTwin");
  });
});

describe("buildCallerIndex stays byte-unchanged (additive-only guard)", () => {
  it("returns exactly the pre-existing def-resolved structure on the mixed scan", () => {
    const index = buildCallerIndex(mixedScan(), new Set());
    expect([...index.entries()]).toEqual([
      [
        "bar",
        {
          def: sym("bar", "src/a.ts", { line: 5, exported: false }),
          callers: [{ file: "src/a.ts", line: 6 }],
        },
      ],
    ]);
  });
});
