import type { Edge, Graph, ModuleNode } from "./types.js";
import { byStr } from "./sort.js";

// The community id of one module — a contract helper for delta and other
// graph consumers.
export function communityOf(graph: Graph, slug: string): number | undefined {
  return graph.modules.find((m) => m.slug === slug)?.community;
}

// Deterministic weighted Louvain (modularity maximization) over the UNDIRECTED
// module graph, used to cluster modules into navigation "communities". This
// layer never feeds `find`'s lexical ranking and never touches module slugs
// (slugs key human-authored prose — reclustering must not renumber them); its
// only ranking role is biasing graph-expansion ordering toward the seeds'
// subsystem, and flagging surprising cross-community edges.
//
// Determinism is load-bearing: community ids land in graph.json / INDEX.md, which
// carry the byte-identical rebuild guarantee. So: NO Math.random; every node is
// swept in a fixed slug-sorted index order; every tie breaks toward the lowest
// community index; and the final ids are derived from a size-descending,
// member-lexicographic reindex that is stable run-to-run for an unchanged repo.

// Resolution parameter. γ = 1.0 is standard Louvain; larger favours smaller
// communities. Kept at 1.0 to match the reference behaviour.
const GAMMA = 1.0;

// Local-move sweeps converge (each sweep only accepts strictly-positive gains),
// but this bounds a pathological float cycle. Aggregation passes strictly shrink
// the node count, so their bound is a pure safety net.
const MAX_SWEEPS = 20;
const MAX_PASSES = 10;

// A move is accepted only when it beats the incumbent by more than EPS, so two
// mathematically-equal gains computed on different float paths never flip the
// partition — the lower community index (swept first) always wins the tie.
const EPS = 1e-12;

// Oversized-community split: a community holding more than 25% of all nodes AND at
// least 10 nodes is re-partitioned on its own induced subgraph. Modularity's
// resolution limit lets a large m merge cohesive sub-clusters that a finer look
// would keep apart; this recovers navigable subsystems. (graphify's cohesion split
// is deliberately NOT ported — it targets thousand-node doc-hub graphs; module
// graphs are far smaller.)
const OVERSIZE_FRACTION = 0.25;
const OVERSIZE_MIN = 10;

// A symmetric weighted graph over contiguous integer node ids. `adj[i]` maps a
// neighbour id to the (accumulated) undirected edge weight; aggregated levels may
// carry self-loops (`adj[i]` containing `i`). `k[i]` is the weighted degree
// (Σ adj[i][*], self-loops included); `twoM` is Σ k = twice the total edge weight.
interface WeightedGraph {
  n: number;
  adj: Map<number, number>[];
  k: number[];
  twoM: number;
}

// Build the undirected weighted adjacency over the (already slug-sorted) node set.
// Dangling edges and edges whose endpoints are not modules are skipped; self-loops
// are dropped (module edges never self-loop, but guard anyway). A directed module
// pair a→b and its mirror b→a both fold into the same undirected weight.
export function buildAdjacency(slugs: string[], edges: Edge[]): WeightedGraph {
  const n = slugs.length;
  const idx = new Map(slugs.map((s, i) => [s, i]));
  const adj: Map<number, number>[] = Array.from({ length: n }, () => new Map<number, number>());
  for (const e of edges) {
    if (e.dangling) continue;
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    adj[a]!.set(b, (adj[a]!.get(b) ?? 0) + e.weight);
    adj[b]!.set(a, (adj[b]!.get(a) ?? 0) + e.weight);
  }
  const k = adj.map((m) => {
    let s = 0;
    for (const w of m.values()) s += w;
    return s;
  });
  const twoM = k.reduce((a, b) => a + b, 0);
  return { n, adj, k, twoM };
}

// Relabel community ids to a dense 0..c-1 range in node order (the community of
// node 0 becomes 0, the next unseen community becomes 1, …). Deterministic and
// only cosmetic — the final reindex overrides these values.
function canonicalize(comm: number[]): { comm: number[]; count: number } {
  const remap = new Map<number, number>();
  const out = new Array<number>(comm.length);
  for (let i = 0; i < comm.length; i++) {
    let id = remap.get(comm[i]!);
    if (id === undefined) {
      id = remap.size;
      remap.set(comm[i]!, id);
    }
    out[i] = id;
  }
  return { comm: out, count: remap.size };
}

// One local-move level: every node starts in its own community, then nodes are
// swept in fixed index order and each moves to the neighbour community with the
// largest modularity gain (ties → lowest community index; a node stays put unless
// a neighbour STRICTLY beats keeping it where it is). Repeats until a sweep moves
// nothing. Returns dense community labels for this level.
function localMove(g: WeightedGraph): { comm: number[]; count: number } {
  const { n, adj, k, twoM } = g;
  const comm = Array.from({ length: n }, (_, i) => i);
  if (twoM === 0) return canonicalize(comm); // no edges → every node isolated
  const commTot = k.slice(); // Σtot per community; each node starts alone

  let moved = true;
  let sweeps = 0;
  while (moved && sweeps < MAX_SWEEPS) {
    moved = false;
    sweeps++;
    for (let i = 0; i < n; i++) {
      const cOld = comm[i]!;
      commTot[cOld]! -= k[i]!; // remove i from its community before scoring moves

      // Weight from i into each neighbouring community (self-loops excluded — they
      // travel with the node and never link it to another community).
      const nb = new Map<number, number>();
      for (const [j, wij] of adj[i]!) {
        if (j === i) continue;
        const cj = comm[j]!;
        nb.set(cj, (nb.get(cj) ?? 0) + wij);
      }

      // Gain of joining community c (relative to i isolated):
      //   score(c) = w(i→c) − γ · k[i] · Σtot(c) / 2m
      // The incumbent is rejoining cOld; in the first sweep cOld is empty, so its
      // score is 0 (the isolated baseline).
      let bestC = cOld;
      let bestScore = (nb.get(cOld) ?? 0) - (GAMMA * k[i]! * commTot[cOld]!) / twoM;
      for (const c of [...nb.keys()].sort((a, b) => a - b)) {
        if (c === cOld) continue;
        const score = nb.get(c)! - (GAMMA * k[i]! * commTot[c]!) / twoM;
        if (score > bestScore + EPS) {
          bestScore = score;
          bestC = c;
        }
      }

      commTot[bestC]! += k[i]!;
      if (bestC !== cOld) {
        comm[i] = bestC;
        moved = true;
      }
    }
  }
  return canonicalize(comm);
}

// Collapse each community into a super-node, summing inter-community weights and
// folding intra-community weight into a self-loop, so modularity is preserved
// across levels (2m is invariant).
function aggregate(g: WeightedGraph, comm: number[], count: number): WeightedGraph {
  const adj: Map<number, number>[] = Array.from({ length: count }, () => new Map<number, number>());
  for (let i = 0; i < g.n; i++) {
    const ci = comm[i]!;
    for (const [j, wij] of g.adj[i]!) {
      const cj = comm[j]!;
      adj[ci]!.set(cj, (adj[ci]!.get(cj) ?? 0) + wij);
    }
  }
  const k = adj.map((m) => {
    let s = 0;
    for (const w of m.values()) s += w;
    return s;
  });
  const twoM = k.reduce((a, b) => a + b, 0);
  return { n: count, adj, k, twoM };
}

// Full multi-level Louvain: local-move, then aggregate and repeat until a level
// merges nothing. Returns a community label per BASE node.
function louvain(g: WeightedGraph): number[] {
  if (g.n === 0) return [];
  let level = g;
  const mapping = Array.from({ length: g.n }, (_, i) => i); // base node → current level node
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const { comm, count } = localMove(level);
    for (let i = 0; i < mapping.length; i++) mapping[i] = comm[mapping[i]!]!;
    if (count === level.n) break; // nothing merged → converged
    level = aggregate(level, comm, count);
  }
  return canonicalize(mapping).comm;
}

// Group node ids by their community label (labels are dense 0..c-1, so slot i is
// community i), preserving ascending node order within each community.
function groupByLabel(labels: number[]): number[][] {
  const groups: number[][] = [];
  for (let i = 0; i < labels.length; i++) {
    (groups[labels[i]!] ??= []).push(i);
  }
  return groups.filter((g) => g && g.length > 0);
}

// Re-run Louvain on the induced subgraph of a community's members (edges leaving
// the community are dropped), returning the sub-communities as base-node id lists.
function louvainInduced(g: WeightedGraph, members: number[]): number[][] {
  const m = members.length;
  const local = new Map<number, number>();
  members.forEach((b, li) => local.set(b, li));
  const adj: Map<number, number>[] = Array.from({ length: m }, () => new Map<number, number>());
  for (let li = 0; li < m; li++) {
    for (const [nb, w] of g.adj[members[li]!]!) {
      const lj = local.get(nb);
      if (lj === undefined) continue; // edge exits the community → excluded
      adj[li]!.set(lj, w);
    }
  }
  const k = adj.map((mp) => {
    let s = 0;
    for (const w of mp.values()) s += w;
    return s;
  });
  const twoM = k.reduce((a, b) => a + b, 0);
  const labels = louvain({ n: m, adj, k, twoM });
  return groupByLabel(labels).map((grp) => grp.map((li) => members[li]!));
}

// Split any oversized community (see OVERSIZE_* constants). Non-recursive: a split
// community's parts are kept as-is even if a part is itself large — one pass is
// enough for navigation and keeps the result predictable.
function splitOversized(groups: number[][], g: WeightedGraph, n: number): number[][] {
  const out: number[][] = [];
  for (const grp of groups) {
    if (grp.length > OVERSIZE_FRACTION * n && grp.length >= OVERSIZE_MIN) {
      const sub = louvainInduced(g, grp);
      if (sub.length > 1) {
        out.push(...sub);
        continue;
      }
    }
    out.push(grp);
  }
  return out;
}

// Compare two sorted slug lists: larger size first, then lexicographically by the
// first differing slug (via byStr). The size-descending, member-lexicographic
// order is what makes ids reproducible for an unchanged partition.
function compareCommunities(a: string[], b: string[]): number {
  if (a.length !== b.length) return b.length - a.length;
  for (let i = 0; i < a.length; i++) {
    const c = byStr(a[i]!, b[i]!);
    if (c) return c;
  }
  return 0;
}

// Assign final ids, reusing previous ids where a new community clearly descends
// from an old one so a small edit does not renumber everything.
//
// Reconciliation rule (deterministic): greedily match new→previous by largest
// member-set intersection (ties: larger intersection, then the new community's
// size-desc index, then the lower previous id). A matched new community keeps its
// previous id when that id is still in range [0, n) and unclaimed; otherwise it is
// demoted to "new". Remaining communities fill the free ids in canonical order.
// This preserves ids across edits AND keeps the id set a contiguous 0..n-1 (a
// previous id ≥ n — from a build that had more communities — cannot be reused
// verbatim without breaking contiguity, so such a community takes a free id).
function assignIds(ordered: string[][], previous?: Record<string, string[]>): number[] {
  const n = ordered.length;
  const ids = new Array<number>(n).fill(-1);
  if (!previous || Object.keys(previous).length === 0) {
    for (let i = 0; i < n; i++) ids[i] = i; // cold build: size-desc canonical ids
    return ids;
  }

  const prevSets = Object.entries(previous).map(([id, members]) => ({
    id: Number(id),
    set: new Set(members),
  }));

  // All overlapping (new, previous) pairs, best-match-first and fully ordered.
  const pairs: { ni: number; prevId: number; inter: number }[] = [];
  ordered.forEach((comm, ni) => {
    for (const prev of prevSets) {
      let inter = 0;
      for (const s of comm) if (prev.set.has(s)) inter++;
      if (inter > 0) pairs.push({ ni, prevId: prev.id, inter });
    }
  });
  pairs.sort((a, b) => b.inter - a.inter || a.ni - b.ni || a.prevId - b.prevId);

  const matched = new Map<number, number>(); // new community index → reused previous id
  const usedPrev = new Set<number>();
  for (const p of pairs) {
    if (matched.has(p.ni) || usedPrev.has(p.prevId)) continue;
    matched.set(p.ni, p.prevId);
    usedPrev.add(p.prevId);
  }

  // Keep a reused id only if it stays inside a contiguous 0..n-1 and is unclaimed.
  const taken = new Set<number>();
  for (let ni = 0; ni < n; ni++) {
    const pid = matched.get(ni);
    if (pid !== undefined && pid >= 0 && pid < n && !taken.has(pid)) {
      ids[ni] = pid;
      taken.add(pid);
    }
  }
  // Fill the gaps with the remaining ids in canonical order.
  const free: number[] = [];
  for (let id = 0; id < n; id++) if (!taken.has(id)) free.push(id);
  let fi = 0;
  for (let ni = 0; ni < n; ni++) if (ids[ni] === -1) ids[ni] = free[fi++]!;
  return ids;
}

// Raw Louvain partition (no oversized split, no reindex) as sorted slug lists —
// exposed for tests that need to observe the pre-split clustering.
export function louvainCommunities(modules: ModuleNode[], edges: Edge[]): string[][] {
  if (modules.length === 0) return [];
  const slugs = modules.map((m) => m.slug).sort(byStr);
  const labels = louvain(buildAdjacency(slugs, edges));
  return groupByLabel(labels).map((grp) => grp.map((i) => slugs[i]!).sort(byStr));
}

// Cluster modules into navigation communities. Returns slug → community id (0-based;
// id 0 is the largest community for a cold build). `previous` (the last manifest's
// communities map) reconciles ids so an unrelated edit does not renumber them.
export function detectCommunities(
  modules: ModuleNode[],
  edges: Edge[],
  previous?: Record<string, string[]>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (modules.length === 0) return out;

  const slugs = modules.map((m) => m.slug).sort(byStr);
  const g = buildAdjacency(slugs, edges);
  const labels = louvain(g);
  const split = splitOversized(groupByLabel(labels), g, slugs.length);
  const communities = split.map((grp) => grp.map((i) => slugs[i]!).sort(byStr));
  communities.sort(compareCommunities); // size-desc, member-lex → stable reindex
  const ids = assignIds(communities, previous);
  communities.forEach((comm, ni) => {
    for (const s of comm) out.set(s, ids[ni]!);
  });
  return out;
}
