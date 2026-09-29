import { describe, it, expect } from "vitest";
import { addDef, importTargets, importedDefs, pickCandidate, resolveCallEdges, type Cand, type DefTable } from "../src/calls.js";
import { buildCallerIndex } from "../src/callers.js";
import { resolveRelations } from "../src/relations.js";
import { buildSymbolGraph } from "../src/symbolgraph.js";
import type { RepoScan } from "../src/scan.js";
import type { CodeSymbol, FileRecord, RawRelation } from "../src/types.js";

// The shared binder plumbing in calls.ts (grouped defs, import targets, the
// split-free proximity score). Every binder used to filter all same-name defs
// per call site and build a `${from}|${to}` string per candidate; these tests
// pin that the grouped path answers exactly what that did — at the scale that
// made it slow (thousands of homonyms) and on the path shapes a character walk
// could get wrong.

function sym(name: string, file: string, o: Partial<CodeSymbol> = {}): CodeSymbol {
  return { name, kind: o.kind ?? "function", file, line: o.line ?? 1, exported: o.exported ?? true, lang: o.lang ?? "typescript" };
}

function file(
  rel: string,
  o: { lang?: string; symbols?: CodeSymbol[]; calls?: { name: string; line: number }[]; relations?: RawRelation[] } = {},
): FileRecord {
  return {
    rel,
    ext: rel.slice(rel.lastIndexOf(".")),
    size: 0,
    lines: 1,
    hash: "h",
    kind: "code",
    lang: o.lang ?? "typescript",
    headings: [],
    symbols: o.symbols ?? [],
    refs: [],
    ...(o.calls ? { calls: o.calls } : {}),
    ...(o.relations ? { relations: o.relations } : {}),
  };
}

function scanOf(files: FileRecord[]): RepoScan {
  return { root: "/repo", files, languages: {}, docText: new Map(), mtimes: new Map(), capped: false, excluded: 0, contentUnchanged: false, cacheDirty: true };
}

// The segment count the binders historically computed, kept here as the oracle.
function splitShared(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

describe("pickCandidate", () => {
  const cand = (f: string): Cand => ({ file: f, lang: "python" });

  it("scores proximity exactly like comparing split segments, on awkward paths", () => {
    const paths = ["", "a", "ab", "a/b", "a/b/c", "a/bc", "a/b/", "a//b", "/a", "/a/b", "a/b/c/d.py", "a/x/d.py", "ab/c", "a/", "x/y/z.py"];
    // Two candidates: the scorer decides between them, so any disagreement with
    // the split oracle on either score flips or ties the answer.
    for (const caller of paths) {
      for (const x of paths) {
        for (const y of paths) {
          if (x === y) continue;
          const sx = splitShared(caller, x);
          const sy = splitShared(caller, y);
          const want = sx === sy ? undefined : sx > sy ? x : y;
          expect(pickCandidate(caller, [cand(x), cand(y)])?.file, `${caller} vs ${x} | ${y}`).toBe(want);
        }
      }
    }
  });

  it("depends on the candidate set, never its order", () => {
    const cands = ["pkg/a/x.py", "pkg/b/x.py", "pkg/a/sub/x.py", "other/x.py"].map(cand);
    const forward = pickCandidate("pkg/a/sub/caller.py", cands);
    expect(forward?.file).toBe("pkg/a/sub/x.py");
    expect(pickCandidate("pkg/a/sub/caller.py", [...cands].reverse())).toBe(forward);
    // A tie at the maximum stays a tie whichever candidate comes first.
    expect(pickCandidate("pkg/c.py", ["pkg/a/x.py", "pkg/b/x.py", "z.py"].map(cand))).toBeUndefined();
    expect(pickCandidate("pkg/c.py", ["z.py", "pkg/b/x.py", "pkg/a/x.py"].map(cand))).toBeUndefined();
  });

  it("returns the candidate object itself", () => {
    const def = sym("f", "a/b.py", { lang: "python" });
    expect(pickCandidate("a/c.py", [def, sym("f", "z/b.py", { lang: "python" })])).toBe(def);
  });
});

describe("importTargets", () => {
  it("answers exactly what `pairs.has(`${from}|${to}`)` answered, even for paths containing '|'", () => {
    const pairs = new Set(["a.ts|b.ts", "a|b.ts|c.ts", "x.ts|x.ts"]);
    const targets = importTargets(pairs);
    const has = (from: string, to: string): boolean => targets.get(from)?.has(to) === true;
    for (const [from, to] of [
      ["a.ts", "b.ts"],
      ["a", "b.ts|c.ts"],
      ["a|b.ts", "c.ts"],
      ["a", "b.ts"],
      ["b.ts", "c.ts"],
    ] as const) {
      const self = from === to;
      expect(has(from, to), `${from} -> ${to}`).toBe(!self && pairs.has(`${from}|${to}`));
    }
    // A self-pair is never a target: no binder ever weighed one.
    expect(has("x.ts", "x.ts")).toBe(false);
  });
});

describe("addDef / importedDefs", () => {
  it("keeps the first def per (name, file) and groups by language family", () => {
    const table: DefTable<CodeSymbol> = new Map();
    const first = sym("f", "a.ts");
    expect(addDef(table, "f", first)).toBe(true);
    expect(addDef(table, "f", sym("f", "a.ts", { line: 9 }))).toBe(false);
    expect(addDef(table, "f", sym("f", "b.js", { lang: "javascript" }))).toBe(true);
    expect(addDef(table, "f", sym("f", "c.py", { lang: "python" }))).toBe(true);
    expect(table.get("f")!.get("js")!.list.map((d) => d.file)).toEqual(["a.ts", "b.js"]);
    expect(table.get("f")!.get("js")!.byFile.get("a.ts")).toBe(first);
    expect(table.get("f")!.get("python")!.list.map((d) => d.file)).toEqual(["c.py"]);
  });

  it("intersects with the import targets from whichever side is smaller", () => {
    const table: DefTable<Cand> = new Map();
    for (let i = 0; i < 50; i++) addDef(table, "C", { file: `t/${i}.ts`, lang: "typescript" });
    const group = table.get("C")!.get("js")!;
    // Few targets (walks the targets) and many targets (walks the defs) agree.
    const few = new Set(["t/7.ts", "elsewhere.ts"]);
    const many = new Set([...Array(80).keys()].map((i) => `t/${i + 7}.ts`));
    expect(importedDefs(group, few).map((d) => d.file)).toEqual(["t/7.ts"]);
    expect(importedDefs(group, many).map((d) => d.file).sort()).toEqual(
      group.list.filter((d) => many.has(d.file)).map((d) => d.file).sort(),
    );
    expect(importedDefs(group, undefined)).toEqual([]);
    // A fresh array each time: resolveRelations appends the same-file def to it.
    expect(importedDefs(group, few)).not.toBe(importedDefs(group, few));
  });
});

// A repo shaped like the TypeScript compiler's test fixtures: one name declared
// in thousands of files, of which the caller imports exactly one.
describe("binding among thousands of homonyms", () => {
  const N = 3000;
  const defs = [...Array(N).keys()].map((i) => file(`tests/cases/c${i}.ts`, { symbols: [sym("C", `tests/cases/c${i}.ts`, { kind: "class" })] }));
  const caller = file("src/app/main.ts", {
    symbols: [sym("run", "src/app/main.ts", { line: 1 })],
    calls: [
      { name: "C", line: 2 },
      { name: "C", line: 3 },
    ],
    relations: [{ kind: "extends", from: "Sub", to: "C", line: 4 }],
  });
  const scan = scanOf([caller, ...defs]);
  const pairs = new Set(["src/app/main.ts|tests/cases/c1234.ts"]);

  it("binds every binder to the imported definition", () => {
    expect(resolveCallEdges(scan, pairs)).toEqual([
      { from: "src/app/main.ts", to: "tests/cases/c1234.ts", kind: "call", weight: 2, confidence: "extracted" },
    ]);
    const index = buildCallerIndex(scan, pairs);
    expect(index.get("C")?.def.file).toBe("tests/cases/c1234.ts");
    expect(index.get("C")?.callers).toEqual([
      { file: "src/app/main.ts", line: 2 },
      { file: "src/app/main.ts", line: 3 },
    ]);
    expect(resolveRelations(scan, pairs).map((r) => r.toFile)).toEqual(["tests/cases/c1234.ts"]);
    const graph = buildSymbolGraph(scan, pairs);
    expect(graph.out.get("src/app/main.ts#run")).toEqual([
      { from: "src/app/main.ts#run", to: "tests/cases/c1234.ts#C", kind: "calls", weight: 2 },
    ]);
  });

  it("keeps the JS/TS gate without an import, and a proximity tie unbound for relations", () => {
    expect(resolveCallEdges(scan, new Set())).toEqual([]);
    expect(buildCallerIndex(scan, new Set()).size).toBe(0);
    // Every fixture shares zero segments with src/app/main.ts: a tie, no edge.
    expect(resolveRelations(scan, new Set())).toEqual([]);
  });

  it("labels recall confidence per site even though each name is bound once per file", () => {
    const withImport = buildCallerIndex(scan, pairs, { recall: true }).get("C")!;
    expect(withImport.callers.map((c) => c.confidence)).toEqual(["corroborated", "corroborated"]);
    const oneDef = scanOf([caller, defs[5]!]);
    const unique = buildCallerIndex(oneDef, new Set(), { recall: true }).get("C")!;
    expect(unique.def.file).toBe("tests/cases/c5.ts");
    expect(unique.callers.map((c) => c.confidence)).toEqual(["unique-name", "unique-name"]);
  });
});
