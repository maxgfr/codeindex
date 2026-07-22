import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pagerankOf, betweennessOf, applyCentrality, BETWEENNESS_MAX_NODES } from "../src/centrality.js";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { renderGraphJson } from "../src/render/graph-json.js";
import type { Edge, FileNode, Graph, ModuleNode } from "../src/types.js";

const edge = (from: string, to: string, weight = 1): Edge => ({ from, to, kind: "import", weight });

const mod = (slug: string): ModuleNode => ({
  id: slug,
  kind: "module",
  slug,
  path: slug,
  title: slug,
  summary: "",
  tier: 1,
  members: [],
  symbols: 0,
  degIn: 0,
  degOut: 0,
});

const file = (rel: string, module: string): FileNode => ({
  id: rel,
  kind: "file",
  rel,
  fileKind: "code",
  lang: "ts",
  module,
  symbols: 0,
  lines: 1,
  degIn: 0,
  degOut: 0,
});

const graphOf = (modules: ModuleNode[], moduleEdges: Edge[], files: FileNode[] = [], fileEdges: Edge[] = []): Graph => ({
  schemaVersion: 4,
  version: "0.0.0",
  fileCount: files.length,
  languages: {},
  files,
  modules,
  fileEdges,
  moduleEdges,
});

describe("pagerankOf", () => {
  it("ranks the heavily-imported center of a star above its leaves", () => {
    const ids = ["center", "l1", "l2", "l3", "l4"];
    const edges = ["l1", "l2", "l3", "l4"].map((l) => edge(l, "center"));
    const pr = pagerankOf(ids, edges);
    for (const l of ["l1", "l2", "l3", "l4"]) {
      expect(pr.get("center")!).toBeGreaterThan(pr.get(l)!);
    }
  });

  it("sums to 1 even with dangling nodes (no outgoing edges)", () => {
    const pr = pagerankOf(["a", "b"], [edge("a", "b")]);
    let sum = 0;
    for (const v of pr.values()) sum += v;
    expect(sum).toBeCloseTo(1, 6);
    // b is imported by a, so b outranks a.
    expect(pr.get("b")!).toBeGreaterThan(pr.get("a")!);
  });

  it("skips dangling edges and edges to unknown ids", () => {
    const edges = [edge("a", "b"), { ...edge("a", "./missing"), dangling: true }, edge("a", "not-a-node")];
    const pr = pagerankOf(["a", "b"], edges);
    const clean = pagerankOf(["a", "b"], [edge("a", "b")]);
    expect([...pr.entries()]).toEqual([...clean.entries()]);
  });

  it("respects edge weight: a heavier importer confers more rank", () => {
    // c splits its vote between a (weight 9) and b (weight 1).
    const pr = pagerankOf(["a", "b", "c"], [edge("c", "a", 9), edge("c", "b", 1)]);
    expect(pr.get("a")!).toBeGreaterThan(pr.get("b")!);
  });

  it("is deterministic across runs", () => {
    const ids = ["a", "b", "c", "d"];
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("d", "a", 3)];
    expect([...pagerankOf(ids, edges).entries()]).toEqual([...pagerankOf(ids, edges).entries()]);
  });
});

describe("betweennessOf", () => {
  it("gives the middle of a path the highest betweenness and the ends zero", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")];
    const bt = betweennessOf(ids, edges);
    expect(bt.get("c")!).toBeGreaterThan(bt.get("b")!);
    expect(bt.get("b")!).toBeGreaterThan(0);
    expect(bt.get("a")).toBe(0);
    expect(bt.get("e")).toBe(0);
    // Exact values on the 5-path: c sits on 4 of the 6 pairs, b/d on 3.
    expect(bt.get("c")!).toBeCloseTo(4 / 6, 6);
    expect(bt.get("b")!).toBeCloseTo(3 / 6, 6);
  });

  it("ranks a low-degree bridge between two cliques above every clique member", () => {
    const a = ["a1", "a2", "a3"];
    const b = ["b1", "b2", "b3"];
    const cliques: Edge[] = [];
    for (const grp of [a, b]) {
      for (let i = 0; i < grp.length; i++) {
        for (let j = i + 1; j < grp.length; j++) cliques.push(edge(grp[i]!, grp[j]!));
      }
    }
    const ids = [...a, ...b, "x"];
    const bt = betweennessOf(ids, [...cliques, edge("a1", "x"), edge("x", "b1")]);
    for (const m of [...a, ...b]) {
      expect(bt.get("x")!).toBeGreaterThan(bt.get(m)!);
    }
  });

  it("returns 0 for every node when the graph has fewer than 3 nodes", () => {
    const bt = betweennessOf(["a", "b"], [edge("a", "b")]);
    expect(bt.get("a")).toBe(0);
    expect(bt.get("b")).toBe(0);
  });

  it("is deterministic across runs", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e"), edge("e", "a")];
    expect([...betweennessOf(ids, edges).entries()]).toEqual([...betweennessOf(ids, edges).entries()]);
  });
});

describe("applyCentrality", () => {
  it("stamps rounded pagerank/betweenness on modules and pagerank on files", () => {
    const modules = ["m1", "m2", "m3"].map(mod);
    const files = [file("m1/a.ts", "m1"), file("m2/b.ts", "m2")];
    const g = graphOf(modules, [edge("m1", "m2"), edge("m2", "m3")], files, [edge("m1/a.ts", "m2/b.ts")]);
    const notes = applyCentrality(g);
    expect(notes).toEqual([]);

    for (const m of g.modules) {
      expect(typeof m.pagerank).toBe("number");
      expect(typeof m.betweenness).toBe("number");
      // Rounded at assignment: 4 dp for pagerank, 6 dp for betweenness.
      expect(Number(m.pagerank!.toFixed(4))).toBe(m.pagerank);
      expect(Number(m.betweenness!.toFixed(6))).toBe(m.betweenness);
    }
    // Scaled pagerank: average node ≈ 1.0, so the total ≈ n.
    const total = g.modules.reduce((s, m) => s + m.pagerank!, 0);
    expect(total).toBeCloseTo(3, 2);
    // m2 sits between m1 and m3 → maximal betweenness (normalized to 1 on a 3-path).
    expect(g.modules.find((m) => m.slug === "m2")!.betweenness).toBe(1);
    // File pagerank: the imported file outranks the importer.
    const [fa, fb] = g.files;
    expect(fb!.pagerank!).toBeGreaterThan(fa!.pagerank!);
  });

  it("skips betweenness past the size guard and reports a note", () => {
    const many = Array.from({ length: BETWEENNESS_MAX_NODES + 1 }, (_, i) => mod(`m${String(i).padStart(4, "0")}`));
    const g = graphOf(many, []);
    const notes = applyCentrality(g);
    expect(notes.some((n) => n.includes("betweenness skipped"))).toBe(true);
    expect(g.modules.every((m) => m.betweenness === undefined)).toBe(true);
    // Pagerank is still computed (uniform on an edge-less graph).
    expect(g.modules.every((m) => typeof m.pagerank === "number")).toBe(true);
  });
});

describe("centrality at build time", () => {
  const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

  it("writes pagerank/betweenness into graph.json, byte-identical across two cold builds", () => {
    const graphA = renderGraphJson(buildIndexArtifacts(REPO).graph);
    const graphB = renderGraphJson(buildIndexArtifacts(REPO).graph);
    expect(graphA).toBe(graphB);
    const parsed = JSON.parse(graphA) as Graph;
    expect(parsed.modules.some((m) => typeof m.pagerank === "number")).toBe(true);
    expect(parsed.modules.some((m) => typeof m.betweenness === "number")).toBe(true);
    expect(parsed.files.some((f) => typeof f.pagerank === "number")).toBe(true);
  });
});
