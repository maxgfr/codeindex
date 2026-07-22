import { describe, it, expect } from "vitest";
import { computeSurprises, isSurprising, SURPRISE_CAP } from "../src/surprise.js";
import type { Edge, Graph, ModuleNode, Tier } from "../src/types.js";

const mod = (slug: string, community: number, tier: Tier = 1): ModuleNode => ({
  id: slug,
  kind: "module",
  slug,
  path: slug,
  title: slug,
  summary: "",
  tier,
  members: [],
  symbols: 1,
  degIn: 0,
  degOut: 0,
  community,
});

const edge = (from: string, to: string, kind: Edge["kind"] = "import", weight = 1): Edge => ({
  from,
  to,
  kind,
  weight,
});

const graphOf = (modules: ModuleNode[], moduleEdges: Edge[]): Graph => ({
  schemaVersion: 4,
  version: "0.0.0",
  fileCount: 0,
  languages: {},
  files: [],
  modules,
  fileEdges: [],
  moduleEdges,
});

// Two 2-module communities linked by a single dependency edge.
const twoIslands = (bridgeKind: Edge["kind"], targetTier: Tier = 1): Graph =>
  graphOf(
    [mod("a1", 0), mod("a2", 0), mod("b1", 1, targetTier), mod("b2", 1)],
    [edge("a1", "a2"), edge("b1", "b2"), edge("a1", "b1", bridgeKind)],
  );

describe("computeSurprises", () => {
  it("flags a lone cross-community dependency edge with its pair count", () => {
    const s = computeSurprises(twoIslands("import"));
    expect(s).toEqual([
      { from: "a1", to: "b1", kind: "import", weight: 1, communities: [0, 1], pairEdges: 1 },
    ]);
  });

  it("does not flag same-community edges, tier-0 targets, or doc kinds", () => {
    expect(computeSurprises(twoIslands("import", 0))).toEqual([]); // shared foundation
    expect(computeSurprises(twoIslands("mention"))).toEqual([]);
    expect(computeSurprises(twoIslands("doc-link"))).toEqual([]);
    const intra = graphOf([mod("a1", 0), mod("a2", 0)], [edge("a1", "a2")]);
    expect(computeSurprises(intra)).toEqual([]);
  });

  it("stops flagging once two communities share more than 2 edges", () => {
    const g = graphOf(
      [mod("a1", 0), mod("a2", 0), mod("b1", 1), mod("b2", 1)],
      [edge("a1", "b1"), edge("a2", "b2"), edge("b1", "a2", "call")],
    );
    expect(computeSurprises(g)).toEqual([]);
  });

  it("sorts by pairEdges then endpoints, caps the list, and is deterministic", () => {
    const modules: ModuleNode[] = [];
    const edges: Edge[] = [];
    for (let i = 0; i < SURPRISE_CAP + 6; i++) {
      const a = `a${String(i).padStart(2, "0")}`;
      const b = `b${String(i).padStart(2, "0")}`;
      modules.push(mod(a, i), mod(b, 100 + i));
      edges.push(edge(a, b));
    }
    const g = graphOf(modules, edges);
    const s = computeSurprises(g);
    expect(s.length).toBe(SURPRISE_CAP);
    expect(s[0]!.from).toBe("a00");
    expect(computeSurprises(g)).toEqual(s);
  });
});

describe("isSurprising", () => {
  it("answers from stored surprises and recomputes when absent", () => {
    const g = twoIslands("import");
    expect(isSurprising(g, "a1", "b1")).toBe(true);
    expect(isSurprising(g, "a1", "a2")).toBe(false);
    g.surprises = computeSurprises(g);
    expect(isSurprising(g, "a1", "b1")).toBe(true);
    expect(isSurprising(g, "b1", "a1")).toBe(false); // directed lookup
  });
});
