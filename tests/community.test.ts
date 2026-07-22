import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCommunities, louvainCommunities } from "../src/community.js";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { renderGraphJson } from "../src/render/graph-json.js";
import type { Edge, ModuleNode } from "../src/types.js";

// Minimal ModuleNode — detectCommunities reads only `slug`; the rest is filler.
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

const edge = (from: string, to: string, weight = 1): Edge => ({ from, to, kind: "import", weight });

// A fully-connected clique among `nodes` with the given intra-edge weight.
function clique(nodes: string[], weight: number): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) out.push(edge(nodes[i]!, nodes[j]!, weight));
  }
  return out;
}

const idOf = (map: Map<string, number>, slug: string) => map.get(slug);

describe("detectCommunities — Louvain", () => {
  it("separates two cliques joined by a single weak edge", () => {
    const a = ["a1", "a2", "a3", "a4"];
    const b = ["b1", "b2", "b3", "b4"];
    const modules = [...a, ...b].map(mod);
    const edges = [...clique(a, 5), ...clique(b, 5), edge("a1", "b1", 1)];
    const c = detectCommunities(modules, edges);

    // Each dense clique lands wholly in one community…
    expect(new Set(a.map((s) => idOf(c, s))).size).toBe(1);
    expect(new Set(b.map((s) => idOf(c, s))).size).toBe(1);
    // …and the two cliques are different communities.
    expect(idOf(c, "a1")).not.toBe(idOf(c, "b1"));
  });

  it("is invariant to the input order of modules and edges (fixed sweep order)", () => {
    const a = ["a1", "a2", "a3", "a4"];
    const b = ["b1", "b2", "b3", "b4"];
    const edges = [...clique(a, 5), ...clique(b, 5), edge("a1", "b1", 1)];
    const forward = detectCommunities([...a, ...b].map(mod), edges);
    const reversed = detectCommunities([...b, ...a].reverse().map(mod), [...edges].reverse());
    expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(forward));
  });

  it("reindexes size-descending: the largest community is id 0", () => {
    const big = ["a1", "a2", "a3", "a4", "a5"];
    const small = ["b1", "b2", "b3"];
    const modules = [...big, ...small].map(mod);
    const edges = [...clique(big, 5), ...clique(small, 5), edge("a1", "b1", 1)];
    const c = detectCommunities(modules, edges);
    expect(idOf(c, "a1")).toBe(0);
    expect(idOf(c, "b1")).toBe(1);
  });

  it("gives an isolated node its own singleton community", () => {
    const modules = ["x", "a1", "a2"].map(mod);
    const edges = [edge("a1", "a2", 5)];
    const c = detectCommunities(modules, edges);
    expect(idOf(c, "a1")).toBe(idOf(c, "a2"));
    expect(idOf(c, "x")).not.toBe(idOf(c, "a1"));
  });

  it("remaps to previous ids so a small edit does not renumber (even against size order)", () => {
    // Previously B was id 0 and A was id 1. A now grows past B in size; a size-desc
    // reindex would flip them, but the remap must preserve the old ids.
    const a = ["a1", "a2", "a3", "a4", "a5"]; // A gains a5
    const b = ["b1", "b2", "b3"];
    const modules = [...a, ...b].map(mod);
    const edges = [...clique(a, 5), ...clique(b, 5), edge("a1", "b1", 1)];
    const previous = { "0": ["b1", "b2", "b3"], "1": ["a1", "a2", "a3", "a4"] };
    const c = detectCommunities(modules, edges, previous);
    expect(idOf(c, "a1")).toBe(1); // kept its previous id despite being larger now
    expect(idOf(c, "a5")).toBe(1); // the new member joins A's (preserved) id
    expect(idOf(c, "b1")).toBe(0);
    // Still a contiguous 0..n-1 set.
    expect(new Set(c.values())).toEqual(new Set([0, 1]));
  });

  it("splits an oversized community that the resolution limit would otherwise merge", () => {
    // Two 6-cliques joined by a weak edge, plus a heavy satellite clique that
    // inflates total edge weight. The large m drives the two cores to MERGE
    // globally (resolution limit), so the raw partition holds a 12-node community.
    const coreA = ["a0", "a1", "a2", "a3", "a4", "a5"];
    const coreB = ["b0", "b1", "b2", "b3", "b4", "b5"];
    const sat = ["s0", "s1", "s2", "s3", "s4", "s5"];
    const modules = [...coreA, ...coreB, ...sat].map(mod);
    const edges = [
      ...clique(coreA, 2),
      ...clique(coreB, 2),
      edge("a0", "b0", 2),
      ...clique(sat, 100), // heavy weight, disconnected from the cores
    ];

    // Precondition: raw Louvain (no split) merges the two cores into one blob.
    const raw = louvainCommunities(modules, edges);
    expect(raw.some((g) => g.length === 12)).toBe(true);

    // With the oversized split, that 12-node blob is re-partitioned into the two
    // cores, yielding three communities.
    const c = detectCommunities(modules, edges);
    expect(new Set(coreA.map((s) => idOf(c, s))).size).toBe(1);
    expect(new Set(coreB.map((s) => idOf(c, s))).size).toBe(1);
    expect(idOf(c, "a0")).not.toBe(idOf(c, "b0"));
    expect(new Set(c.values()).size).toBe(3);
  });

  it("returns an id for every module, even with no edges", () => {
    const modules = ["p", "q", "r"].map(mod);
    const c = detectCommunities(modules, []);
    expect(c.size).toBe(3);
    // No edges → three singletons, one per node.
    expect(new Set(c.values()).size).toBe(3);
  });
});

describe("community detection at build time", () => {
  const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

  it("writes community ids into graph.json and is byte-identical across two cold builds", () => {
    const graphA = renderGraphJson(buildIndexArtifacts(REPO).graph);
    const graphB = renderGraphJson(buildIndexArtifacts(REPO).graph);
    expect(graphA).toBe(graphB);
    // Communities actually landed in the serialized graph.
    const parsed = JSON.parse(graphA) as { modules: { community?: number }[] };
    expect(parsed.modules.some((m) => typeof m.community === "number")).toBe(true);
  });

  it("reproduces the same ids on a rebuild seeded with the prior communities", () => {
    const { graph: cold } = buildIndexArtifacts(REPO); // cold — no prev
    const coldJson = renderGraphJson(cold);
    // Rebuild seeded with the cold run's partition (the manifest `communities`
    // shape a consumer would persist): ids must remap to the same values.
    const prev: Record<string, string[]> = {};
    for (const m of cold.modules) {
      if (m.community === undefined) continue;
      (prev[String(m.community)] ??= []).push(m.slug);
    }
    const { graph: warm } = buildIndexArtifacts(REPO, { previousCommunities: prev });
    expect(renderGraphJson(warm)).toBe(coldJson);
  });
});
