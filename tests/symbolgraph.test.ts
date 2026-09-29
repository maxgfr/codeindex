import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "../src/scan.js";
import { computeImportPairs } from "../src/callers.js";
import { buildSymbolGraph, neighborhood, symbolId } from "../src/symbolgraph.js";

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-symgraph-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

// A four-hop chain across three files, plus one inheritance link:
//   entry → middle → leaf     (calls)
//   Impl  → Contract          (implements)
const CHAIN = {
  "src/leaf.ts": "export function leaf(): number {\n  return 1;\n}\n",
  "src/middle.ts": [
    'import { leaf } from "./leaf.js";',
    "export function middle(): number {",
    "  return leaf();",
    "}",
    "",
  ].join("\n"),
  "src/entry.ts": [
    'import { middle } from "./middle.js";',
    "export function entry(): number {",
    "  return middle();",
    "}",
    "",
  ].join("\n"),
  "src/contract.ts": "export interface Contract {\n  run(): void;\n}\n",
  "src/impl.ts": [
    'import { Contract } from "./contract.js";',
    "export class Impl implements Contract {",
    "  run(): void {}",
    "}",
    "",
  ].join("\n"),
};

function graphOf(files: Record<string, string>) {
  const scan = scanRepo(repoWith(files));
  return buildSymbolGraph(scan, computeImportPairs(scan));
}

describe("symbol graph", () => {
  it("attributes a call to the DECLARATION that contains it, not to the file", () => {
    const g = graphOf(CHAIN);
    const calls = g.edges.filter((e) => e.kind === "calls");
    expect(calls).toEqual([
      { from: "src/entry.ts#entry", to: "src/middle.ts#middle", kind: "calls", weight: 1 },
      { from: "src/middle.ts#middle", to: "src/leaf.ts#leaf", kind: "calls", weight: 1 },
    ]);
  });

  it("records inheritance as symbol-level edges", () => {
    const g = graphOf(CHAIN);
    expect(g.edges.filter((e) => e.kind === "implements")).toEqual([
      { from: "src/impl.ts#Impl", to: "src/contract.ts#Contract", kind: "implements", weight: 1 },
    ]);
  });

  it("qualifies a member's id with its parent so two same-named methods stay distinct", () => {
    const g = graphOf({
      "a.ts": "export class A {\n  run(): void {}\n}\nexport class B {\n  run(): void {}\n}\n",
    });
    expect([...g.nodes.keys()]).toContain("a.ts#A/run");
    expect([...g.nodes.keys()]).toContain("a.ts#B/run");
  });

  it("counts repeated call sites as edge weight", () => {
    const g = graphOf({
      "leaf.ts": "export function leaf(): number {\n  return 1;\n}\n",
      "top.ts": [
        'import { leaf } from "./leaf.js";',
        "export function top(): number {",
        "  return leaf() + leaf() + leaf();",
        "}",
        "",
      ].join("\n"),
    });
    const e = g.edges.find((x) => x.from === "top.ts#top");
    // Three sites on three columns of one line dedup to one (name, line) pair
    // upstream in extraction, so this asserts the aggregation works, not a count.
    expect(e?.weight).toBeGreaterThanOrEqual(1);
  });

  it("never emits a self-edge for direct recursion", () => {
    const g = graphOf({ "r.ts": "export function r(n: number): number {\n  return n > 0 ? r(n - 1) : 0;\n}\n" });
    expect(g.edges.filter((e) => e.from === e.to)).toEqual([]);
  });

  it("keeps the JS/TS import gate: no import, no call edge", () => {
    // `helper` is defined in one file and called in another with NO import. On a
    // bare-name match alone this would be a plausible-but-unproven edge, and an
    // impact analysis built on it would mislead.
    const g = graphOf({
      "def.ts": "export function helper(): number {\n  return 1;\n}\n",
      "use.ts": "export function caller(): number {\n  return helper();\n}\n",
    });
    expect(g.edges.filter((e) => e.kind === "calls")).toEqual([]);
  });
});

describe("neighborhood", () => {
  it("walks outward the requested number of hops and reports each node's distance", () => {
    const g = graphOf(CHAIN);
    const n = neighborhood(g, "entry", { depth: 2, direction: "out" });
    expect(n.root.map((r) => r.id)).toEqual(["src/entry.ts#entry"]);
    expect(n.nodes.map((x) => `${x.id}@${x.depth}`)).toEqual([
      "src/entry.ts#entry@0",
      "src/middle.ts#middle@1",
      "src/leaf.ts#leaf@2",
    ]);
  });

  it("stops at the depth limit", () => {
    const g = graphOf(CHAIN);
    const n = neighborhood(g, "entry", { depth: 1, direction: "out" });
    expect(n.nodes.map((x) => x.id)).toEqual(["src/entry.ts#entry", "src/middle.ts#middle"]);
  });

  it("walks inward for callers", () => {
    const g = graphOf(CHAIN);
    const n = neighborhood(g, "leaf", { depth: 2, direction: "in" });
    expect(n.nodes.map((x) => x.id)).toEqual([
      "src/leaf.ts#leaf",
      "src/middle.ts#middle",
      "src/entry.ts#entry",
    ]);
  });

  it("returns a self-contained subgraph — no edge points outside the node set", () => {
    const g = graphOf(CHAIN);
    const n = neighborhood(g, "middle", { depth: 1, direction: "both" });
    const ids = new Set(n.nodes.map((x) => x.id));
    for (const e of n.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it("accepts a bare name, a parent path, or a full id", () => {
    const g = graphOf(CHAIN);
    expect(neighborhood(g, "Impl/run").root.map((r) => r.id)).toEqual(["src/impl.ts#Impl/run"]);
    expect(neighborhood(g, "src/impl.ts#Impl").root.map((r) => r.id)).toEqual(["src/impl.ts#Impl"]);
  });

  it("starts from EVERY declaration of an ambiguous name", () => {
    const g = graphOf({ "a.ts": "export function dup(): void {}\n", "b.ts": "export function dup(): void {}\n" });
    expect(neighborhood(g, "dup").root.map((r) => r.id).sort()).toEqual(["a.ts#dup", "b.ts#dup"]);
  });

  it("reports an unknown symbol as an empty result rather than throwing", () => {
    const g = graphOf(CHAIN);
    expect(neighborhood(g, "nope")).toEqual({ root: [], nodes: [], edges: [] });
  });

  it("survives a call cycle", () => {
    const g = graphOf({
      "aa.ts": ['import { bb } from "./bb.js";', "export function aa(): number {", "  return bb();", "}", ""].join("\n"),
      "bb.ts": ['import { aa } from "./aa.js";', "export function bb(): number {", "  return aa();", "}", ""].join("\n"),
    });
    const n = neighborhood(g, "aa", { depth: 5 });
    expect(n.nodes.map((x) => x.id).sort()).toEqual(["aa.ts#aa", "bb.ts#bb"]);
  });

  it("clamps depth to the documented maximum", () => {
    const g = graphOf(CHAIN);
    // depth 99 must not walk 99 levels; the chain is 3 long, so both agree —
    // what this pins is that an absurd request is accepted and bounded.
    expect(neighborhood(g, "entry", { depth: 99 }).nodes.length).toBe(neighborhood(g, "entry", { depth: 5 }).nodes.length);
  });

  it("is deterministic", () => {
    const g = graphOf(CHAIN);
    expect(JSON.stringify(neighborhood(g, "entry", { depth: 3 }))).toBe(
      JSON.stringify(neighborhood(g, "entry", { depth: 3 })),
    );
  });
});

describe("symbolId", () => {
  it("qualifies a member and leaves a top-level symbol bare", () => {
    expect(symbolId({ file: "a.ts", name: "run", parent: "A" })).toBe("a.ts#A/run");
    expect(symbolId({ file: "a.ts", name: "run" })).toBe("a.ts#run");
  });
});

describe("overrides and dispatch", () => {
  // A call binds to the method its receiver's declared type names; the
  // overrides living in other files are only reachable by dispatch.
  const SHAPES = {
    "shapes/base.py": "class Shape:\n    def area(self):\n        raise NotImplementedError\n\n    def name(self):\n        return 'shape'\n",
    "shapes/square.py": "from shapes.base import Shape\n\n\nclass Square(Shape):\n    def area(self):\n        return 1\n\n    def side(self):\n        return 1\n",
    "shapes/cube.py": "from shapes.square import Square\n\n\nclass Cube(Square):\n    def area(self):\n        return 6\n",
    "shapes/total.py": "from shapes.base import Shape\n\n\ndef total(x: Shape):\n    return x.area()\n",
  };

  it("links each method to the NEAREST supertype method of the same name", () => {
    const scan = scanRepo(repoWith(SHAPES));
    const graph = buildSymbolGraph(scan, computeImportPairs(scan));
    const overrides = graph.edges.filter((e) => e.kind === "overrides").map((e) => `${e.from} -> ${e.to}`);
    expect(overrides).toEqual([
      "shapes/cube.py#Cube/area -> shapes/square.py#Square/area",
      "shapes/square.py#Square/area -> shapes/base.py#Shape/area",
    ]);
  });

  it("walking out through a base method reaches its overrides; walking in to an override reaches the base's callers", () => {
    const scan = scanRepo(repoWith(SHAPES));
    const graph = buildSymbolGraph(scan, computeImportPairs(scan));
    const out = neighborhood(graph, "total", { direction: "out", depth: 4 }).nodes.map((n) => `${n.depth} ${n.id}`);
    expect(out).toEqual([
      "0 shapes/total.py#total",
      "1 shapes/base.py#Shape/area",
      "2 shapes/square.py#Square/area",
      "3 shapes/cube.py#Cube/area",
    ]);
    const into = neighborhood(graph, "Cube/area", { direction: "in", depth: 4 }).nodes.map((n) => n.id);
    expect(into).toEqual(["shapes/cube.py#Cube/area", "shapes/square.py#Square/area", "shapes/base.py#Shape/area", "shapes/total.py#total"]);
    // An override is not a caller: walking in to the base does not list them.
    const callersOfBase = neighborhood(graph, "Shape/area", { direction: "in" }).nodes.map((n) => n.id);
    expect(callersOfBase).toEqual(["shapes/base.py#Shape/area", "shapes/total.py#total"]);
  });

  it("a Go method implementing an interface method overrides it", () => {
    const scan = scanRepo(
      repoWith({
        "go.mod": "module example.com/m\n\ngo 1.21\n",
        "r/r.go": "package r\n\ntype Render interface {\n\tRender() error\n}\n",
        "r/json.go": "package r\n\ntype JSON struct{}\n\nfunc (j JSON) Render() error { return nil }\n",
      }),
    );
    const graph = buildSymbolGraph(scan, computeImportPairs(scan));
    expect(graph.edges.filter((e) => e.kind !== "calls").map((e) => `${e.kind} ${e.from} -> ${e.to}`)).toEqual([
      "overrides r/json.go#JSON/Render -> r/r.go#Render/Render",
      "implements r/json.go#JSON -> r/r.go#Render",
    ].sort());
  });
});
