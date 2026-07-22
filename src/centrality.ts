import type { Edge, Graph } from "./types.js";

// Deterministic centrality over the link-graph, feeding hub/bridge ranking and
// the delta risk panel. Like the community layer, determinism is load-bearing:
// scores land in graph.json (byte-identical rebuild guarantee), so node arrays
// are consumed in their stored (sorted) order, adjacency is built in edge order,
// and every float is rounded once at assignment — a fixed op order plus
// ECMA-262's specified number→string conversion keeps bytes stable across
// platforms. No Math.random anywhere.

// PageRank: standard damping, L1-convergence threshold, iteration safety cap.
const DAMPING = 0.85;
const MAX_ITERS = 100;
const CONVERGENCE = 1e-10;

// Brandes betweenness is O(V·E); module graphs are small, but a pathological
// repo (thousands of single-file modules) could stall a build. Past this cap
// the field is left absent and a build note says so.
export const BETWEENNESS_MAX_NODES = 3000;

// Weighted, directed PageRank over the given node ids. Edges are used exactly
// as stored (from → to), so a heavily-imported node ranks high. Dangling edges,
// self-loops, and edges whose endpoints are not in `ids` are skipped — the same
// graph view the degree fields and the Louvain adjacency use. Nodes with no
// outgoing weight redistribute their mass uniformly each iteration (the classic
// dangling-node fix), so the returned values always sum to 1.
export function pagerankOf(ids: string[], edges: Edge[], damping = DAMPING): Map<string, number> {
  const out = new Map<string, number>();
  const n = ids.length;
  if (n === 0) return out;
  const idx = new Map(ids.map((s, i) => [s, i]));
  const adj: [number, number][][] = Array.from({ length: n }, () => []);
  const outW = new Array<number>(n).fill(0);
  for (const e of edges) {
    if (e.dangling) continue;
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    adj[a]!.push([b, e.weight]);
    outW[a]! += e.weight;
  }

  let pr = new Array<number>(n).fill(1 / n);
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outW[i] === 0) dangling += pr[i]!;
    const base = (1 - damping) / n + (damping * dangling) / n;
    const next = new Array<number>(n).fill(base);
    for (let i = 0; i < n; i++) {
      if (outW[i] === 0) continue;
      const share = (damping * pr[i]!) / outW[i]!;
      for (const [j, w] of adj[i]!) next[j]! += share * w;
    }
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i]! - pr[i]!);
    pr = next;
    if (delta < CONVERGENCE) break;
  }
  ids.forEach((s, i) => out.set(s, pr[i]!));
  return out;
}

// Brandes betweenness over the UNDIRECTED, UNWEIGHTED view of the edges —
// hop-count BFS keeps the path counts σ integral, so there are no float
// shortest-path ties to break. Neighbour lists are deduped and iterated in
// ascending index order; the source loop runs in index order — the accumulation
// order is therefore a pure function of the (sorted) input. Normalized by the
// pair count (n-1)(n-2)/2 into [0,1]; below 3 nodes every value is 0.
export function betweennessOf(ids: string[], edges: Edge[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of ids) out.set(s, 0);
  const n = ids.length;
  if (n < 3) return out;
  const idx = new Map(ids.map((s, i) => [s, i]));
  const nbSets: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (const e of edges) {
    if (e.dangling) continue;
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    nbSets[a]!.add(b);
    nbSets[b]!.add(a);
  }
  const adj = nbSets.map((s) => [...s].sort((x, y) => x - y));

  const cb = new Array<number>(n).fill(0);
  for (let s = 0; s < n; s++) {
    const stack: number[] = [];
    const pred: number[][] = Array.from({ length: n }, () => []);
    const sigma = new Array<number>(n).fill(0);
    const dist = new Array<number>(n).fill(-1);
    sigma[s] = 1;
    dist[s] = 0;
    const queue: number[] = [s];
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi]!;
      stack.push(v);
      for (const w of adj[v]!) {
        if (dist[w]! < 0) {
          dist[w] = dist[v]! + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v]! + 1) {
          sigma[w]! += sigma[v]!;
          pred[w]!.push(v);
        }
      }
    }
    const delta = new Array<number>(n).fill(0);
    for (let si = stack.length - 1; si >= 0; si--) {
      const w = stack[si]!;
      for (const v of pred[w]!) delta[v]! += (sigma[v]! / sigma[w]!) * (1 + delta[w]!);
      if (w !== s) cb[w]! += delta[w]!;
    }
  }
  // Each undirected pair was counted from both endpoints → halve, then normalize.
  const norm = ((n - 1) * (n - 2)) / 2;
  ids.forEach((id, i) => out.set(id, cb[i]! / 2 / norm));
  return out;
}

// Stamp centrality onto the graph's nodes in place (the `m.community` pattern:
// fields assigned in fixed code order so graph.json key order stays stable).
// Pagerank is stored SCALED by the node count — the average node is 1.0, hubs
// read as "3.2× the average" — and survives 4-dp rounding on graphs where the
// raw probability would round to zero. Returns build notes (skipped passes).
export function applyCentrality(graph: Graph): string[] {
  const notes: string[] = [];
  const nM = graph.modules.length;
  if (nM > 0) {
    const mIds = graph.modules.map((m) => m.id);
    const mPr = pagerankOf(mIds, graph.moduleEdges);
    for (const m of graph.modules) m.pagerank = Number(((mPr.get(m.id) ?? 0) * nM).toFixed(4));
    if (nM > BETWEENNESS_MAX_NODES) {
      notes.push(`betweenness skipped (${nM} modules > ${BETWEENNESS_MAX_NODES})`);
    } else {
      const bt = betweennessOf(mIds, graph.moduleEdges);
      for (const m of graph.modules) m.betweenness = Number((bt.get(m.id) ?? 0).toFixed(6));
    }
  }
  const nF = graph.files.length;
  if (nF > 0) {
    const fIds = graph.files.map((f) => f.id);
    const fPr = pagerankOf(fIds, graph.fileEdges);
    for (const f of graph.files) f.pagerank = Number(((fPr.get(f.id) ?? 0) * nF).toFixed(4));
  }
  return notes;
}
