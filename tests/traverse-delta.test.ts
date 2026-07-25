import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { scanRepo } from "../src/scan.js";
import { buildResolveContext } from "../src/resolve.js";
import { buildModules } from "../src/modules.js";
import { buildGraph } from "../src/graph.js";
import { buildSymbolIndex } from "../src/render/symbols-json.js";
import { symbolRefsFor } from "../src/derived.js";
import { impactOf, neighborsOf, reverseClosure, hubThreshold } from "../src/traverse.js";
import { computeDelta, symbolsInHunks, RISK_WEIGHTS } from "../src/delta.js";
import { renderMermaidClustered } from "../src/viz.js";
import type { Edge, Graph } from "../src/types.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

function build(): Graph {
  const scan = scanRepo(REPO);
  const ctx = buildResolveContext(scan);
  const { modules, moduleOf } = buildModules(scan);
  return buildGraph(scan, ctx, modules, moduleOf);
}

const edge = (from: string, to: string, kind: Edge["kind"]): Edge =>
  ({ from, to, kind, weight: 1 }) as Edge;

describe("hubThreshold", () => {
  it("floors at 50 so small graphs are ungated (never worse than no gate)", () => {
    expect(hubThreshold([])).toBe(50);
    expect(hubThreshold([1, 2, 3])).toBe(50);
  });
  it("rises to p99 once the distribution exceeds the floor", () => {
    const degrees = [...Array(100).keys()].map((i) => i * 10); // 0..990
    expect(hubThreshold(degrees)).toBeGreaterThan(50);
  });
});

describe("reverseClosure", () => {
  const edges = [
    edge("b.ts", "a.ts", "import"),
    edge("c.ts", "b.ts", "import"),
    edge("d.ts", "c.ts", "use"),
    edge("readme.md", "a.ts", "doc-link"), // NOT a depends-on relation
  ];

  it("walks dependents transitively, recording the nearest depth", () => {
    const got = reverseClosure(edges, ["a.ts"]);
    expect(got.get("b.ts")).toBe(1);
    expect(got.get("c.ts")).toBe(2);
    expect(got.get("d.ts")).toBe(3);
  });

  it("excludes doc-link and mention — those reference, they do not break", () => {
    expect(reverseClosure(edges, ["a.ts"]).has("readme.md")).toBe(false);
  });

  it("honours the depth bound", () => {
    const got = reverseClosure(edges, ["a.ts"], 1);
    expect([...got.keys()]).toEqual(["b.ts"]);
  });

  it("never revisits a seed, so a cycle terminates", () => {
    const cyclic = [edge("a.ts", "b.ts", "import"), edge("b.ts", "a.ts", "import")];
    expect(() => reverseClosure(cyclic, ["a.ts"])).not.toThrow();
    expect(reverseClosure(cyclic, ["a.ts"]).has("a.ts")).toBe(false);
  });
});

describe("impactOf", () => {
  const graph = build();

  it("resolves a module slug and a file rel, and reports which it matched", () => {
    expect(impactOf(graph, "src")?.scope).toBe("module");
    expect(impactOf(graph, "src/util.ts")?.scope).toBe("file");
    expect(impactOf(graph, "nope")).toBeUndefined();
  });

  it("seeds a module target with all its members", () => {
    const res = impactOf(graph, "src")!;
    expect(res.seeds.length).toBeGreaterThan(1);
    expect(res.seeds.every((s) => s.startsWith("src/"))).toBe(true);
  });

  it("returns dependents nearest-first and never lists the target's own module", () => {
    const res = impactOf(graph, "src/util.ts")!;
    const depths = res.files.map((f) => f.depth);
    expect([...depths].sort((a, b) => a - b)).toEqual(depths);
    expect(res.modules).not.toContain("src/util.ts");
  });
});

describe("neighborsOf", () => {
  const graph = build();

  it("walks both directions from a module", () => {
    const res = neighborsOf(graph, "src", 1)!;
    expect(res.scope).toBe("module");
    expect(res.members?.length).toBeGreaterThan(0);
    expect(res.links.every((l) => l.depth === 1)).toBe(true);
  });

  it("filters by edge kind, and the filtered view yields no other kinds", () => {
    const res = neighborsOf(graph, "src", 2, new Set(["import"]))!;
    expect(res.links.every((l) => l.kind === "import")).toBe(true);
  });

  it("is deterministic across calls", () => {
    expect(neighborsOf(graph, "src", 2)).toEqual(neighborsOf(graph, "src", 2));
  });
});

describe("symbolsInHunks", () => {
  const defs = [
    { name: "outer", file: "a.ts", line: 1, endLine: 20, kind: "function", exported: true },
    { name: "inner", file: "a.ts", line: 5, endLine: 8, kind: "function", exported: false },
  ];

  it("returns every enclosing symbol, innermost first", () => {
    const got = symbolsInHunks(defs, [{ start: 6, end: 7 }]);
    expect(got.map((s) => s.name)).toEqual(["inner", "outer"]);
    expect(got.every((s) => s.approx === undefined)).toBe(true);
  });

  it("falls back to the nearest def above ONLY when no endLine is known, and says so", () => {
    const regexDefs = [{ name: "loose", file: "a.ts", line: 3, kind: "function", exported: true }];
    const got = symbolsInHunks(regexDefs, [{ start: 9, end: 9 }]);
    expect(got).toHaveLength(1);
    expect(got[0]!.approx).toBe(true);
  });

  it("attributes nothing when a hunk sits outside every known range", () => {
    expect(symbolsInHunks(defs, [{ start: 40, end: 41 }])).toEqual([]);
  });
});

describe("computeDelta", () => {
  const graph = build();
  const scan = scanRepo(REPO);
  const symbols = buildSymbolIndex(scan, symbolRefsFor(scan));
  const base = { ref: "main", mergeBase: "abc1234", staged: false };

  it("attributes a changed file to its module and explains every point it scores", () => {
    const target = graph.files.find((f) => f.rel === "src/util.ts")!;
    const res = computeDelta(
      graph,
      symbols,
      { files: [{ path: target.rel, status: "modified" }], hunks: new Map([[target.rel, [{ start: 1, end: 5 }]]]), base },
    );
    expect(res.changes[0]?.module).toBe("src");
    const mod = res.modules.find((m) => m.slug === "src");
    expect(mod).toBeDefined();
    // The contract that makes the panel reviewable: a nonzero score is never
    // unexplained. Every weight that fired left a reason behind.
    if (mod!.score > 0) expect(mod!.reasons.length).toBeGreaterThan(0);
    expect(mod!.score).toBeLessThanOrEqual(100);
  });

  it("lists a file the index does not know as unindexed rather than scoring it", () => {
    const res = computeDelta(graph, symbols, { files: [{ path: "not/indexed.ts", status: "modified" }], hunks: new Map(), base });
    expect(res.unindexed).toEqual(["not/indexed.ts"]);
    expect(res.modules).toEqual([]);
  });

  it("records a deletion without attributing symbols to it", () => {
    const res = computeDelta(graph, symbols, { files: [{ path: "src/util.ts", status: "deleted" }], hunks: new Map(), base });
    expect(res.deleted).toEqual(["src/util.ts"]);
    expect(res.changes[0]?.symbols).toEqual([]);
  });

  it("notes the missing symbol index instead of silently dropping attribution", () => {
    const res = computeDelta(graph, undefined, { files: [], hunks: new Map(), base });
    expect(res.notes.some((n) => /symbol index missing/.test(n))).toBe(true);
  });

  it("treats a wholly-added file as changed end to end", () => {
    const target = graph.files.find((f) => f.rel === "src/util.ts")!;
    const res = computeDelta(graph, symbols, { files: [{ path: target.rel, status: "added" }], hunks: new Map(), base });
    expect(res.changes[0]?.hunks).toEqual([{ start: 1, end: Math.max(target.lines, 1) }]);
  });

  it("does not charge dangling RISK for an import into an ignored tree", () => {
    // A relative import into vendor/ (or dist/, build/ …) resolves to a file
    // that exists and works, but the walker never indexed it, so the resolver
    // reports the edge as dangling. Charging RISK_WEIGHTS.dangling for that
    // would give any repo that vendors a dependency a permanent penalty on every
    // change to the file importing it — which is what this repo's own consumers
    // hit. The edge is still LISTED so the graph blind spot stays visible.
    const target = graph.files.find((f) => f.rel === "src/util.ts")!;
    const withVendorEdge: Graph = {
      ...graph,
      fileEdges: [
        ...graph.fileEdges,
        { from: target.rel, to: "./vendor/engine.mjs", kind: "import", weight: 1, dangling: true, reason: "missing-module" } as Edge,
        { from: target.rel, to: "./genuinely-gone", kind: "import", weight: 1, dangling: true, reason: "missing-module" } as Edge,
      ],
    };
    const res = computeDelta(withVendorEdge, symbols, {
      files: [{ path: target.rel, status: "modified" }],
      hunks: new Map([[target.rel, [{ start: 1, end: 3 }]]]),
      base,
    });
    // Both are reported...
    expect(res.dangling.map((d) => d.spec).sort()).toEqual(["./genuinely-gone", "./vendor/engine.mjs"]);
    // ...but only the genuinely-broken one is named as a reason.
    const mod = res.modules.find((m) => m.slug === "src")!;
    const danglingReasons = mod.reasons.filter((r) => r.startsWith("dangling import"));
    expect(danglingReasons).toHaveLength(1);
    expect(danglingReasons[0]).toContain("./genuinely-gone");
    expect(danglingReasons[0]).not.toContain("vendor");
  });

  it("keeps the weight table pinned — a silent reweight changes every review", () => {
    expect(RISK_WEIGHTS).toEqual({
      exportedChange: 25,
      hubHigh: 20,
      hubMed: 10,
      blastHigh: 20,
      blastMed: 10,
      testGap: 20,
      surprise: 10,
      dangling: 15,
    });
  });

  it("is deterministic", () => {
    const args = { files: [{ path: "src/util.ts", status: "modified" as const }], hunks: new Map(), base };
    expect(computeDelta(graph, symbols, args)).toEqual(computeDelta(graph, symbols, args));
  });
});

describe("renderMermaidClustered", () => {
  const graph = build();

  it("fences the diagram and groups nodes into tier subgraphs", () => {
    const res = renderMermaidClustered(graph);
    expect(res.content.startsWith("```mermaid\n")).toBe(true);
    expect(res.content.trimEnd().endsWith("```")).toBe(true);
    expect(res.content).toContain("flowchart LR");
    expect(res.content).toMatch(/subgraph (Foundations|Features|Tail)/);
  });

  it("reports what it dropped instead of truncating silently", () => {
    const res = renderMermaidClustered(graph, { maxModules: 1 });
    expect(res.shownModules).toBe(1);
    expect(res.totalModules).toBe(graph.modules.length);
    expect(res.content).toContain("truncated to the most-connected");
  });

  it("never renders an edge whose endpoint was dropped by the module cap", () => {
    const res = renderMermaidClustered(graph, { maxModules: 1 });
    expect(res.shownEdges).toBe(0);
  });

  it("is deterministic", () => {
    expect(renderMermaidClustered(graph)).toEqual(renderMermaidClustered(graph));
  });
});
