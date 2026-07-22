import type { Graph, SurpriseEdge } from "./types.js";
import { byStr } from "./sort.js";

// Surprising cross-community coupling: a dependency edge that is one of at most
// two links between two otherwise-separate subsystems. These are the places
// where the architecture leaks — an agent reviewing a change touching one
// deserves a nudge. Deliberately conservative: doc-links/mentions crossing
// communities are normal, and everyone importing shared foundations (tier 0)
// across communities is expected.
export const SURPRISE_CAP = 24;
const MAX_PAIR_EDGES = 2;

const DEP_KINDS = new Set(["import", "call", "use"]);

// One O(E) pass over the module edges. Deterministic: candidates keep the
// stored edge order until the final (pairEdges asc, from, to) sort.
export function computeSurprises(graph: Graph): SurpriseEdge[] {
  const commOf = new Map<string, number>();
  const tierOf = new Map<string, number>();
  for (const m of graph.modules) {
    if (m.community !== undefined) commOf.set(m.slug, m.community);
    tierOf.set(m.slug, m.tier);
  }

  const pairCount = new Map<string, number>();
  const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const candidates: { edge: Graph["moduleEdges"][number]; comms: [number, number] }[] = [];
  for (const e of graph.moduleEdges) {
    if (e.dangling) continue;
    const ca = commOf.get(e.from);
    const cb = commOf.get(e.to);
    if (ca === undefined || cb === undefined || ca === cb) continue;
    pairCount.set(pairKey(ca, cb), (pairCount.get(pairKey(ca, cb)) ?? 0) + 1);
    if (!DEP_KINDS.has(e.kind)) continue;
    if (tierOf.get(e.to) === 0) continue;
    candidates.push({ edge: e, comms: [ca, cb] });
  }

  return candidates
    .filter((c) => pairCount.get(pairKey(c.comms[0], c.comms[1]))! <= MAX_PAIR_EDGES)
    .map((c) => ({
      from: c.edge.from,
      to: c.edge.to,
      kind: c.edge.kind,
      weight: c.edge.weight,
      communities: c.comms,
      pairEdges: pairCount.get(pairKey(c.comms[0], c.comms[1]))!,
    }))
    .sort((a, b) => a.pairEdges - b.pairEdges || byStr(a.from, b.from) || byStr(a.to, b.to))
    .slice(0, SURPRISE_CAP);
}

// Is the directed module edge from→to flagged surprising? Reads the stored
// build-time list when present, recomputes otherwise.
export function isSurprising(graph: Graph, from: string, to: string): boolean {
  const list = graph.surprises ?? computeSurprises(graph);
  return list.some((s) => s.from === from && s.to === to);
}
