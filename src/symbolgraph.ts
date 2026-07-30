// The graph at SYMBOL granularity, and bounded neighborhoods of it.
//
// WHY THIS EXISTS. `graph.json` links files, and `callers` answers one inbound
// hop for one symbol. Neither answers the question an agent actually asks before
// changing something: "what does this reach, and what reaches it, a couple of
// hops out?" Answering it from the file graph is far too coarse (one file's
// twenty symbols become one node), and answering it from `callers` means the
// agent issuing a fan of calls and stitching the result together itself.
//
// So this derives symbol→symbol edges from data that already exists — call sites
// with their enclosing declaration (callers.ts) and resolved inheritance
// (relations.ts) — and walks a bounded neighborhood. Nothing new is persisted:
// the graph is built on demand from the scan, so no artifact or schema grows.
import type { CodeSymbol } from "./types.js";
import type { RepoScan } from "./scan.js";
import { familyOf, pickCandidate, type Cand } from "./calls.js";
import { enclosingAmong } from "./callers.js";
import { resolveRelations } from "./relations.js";
import { byStr } from "./sort.js";

// Internal Map-key separator. Written as an ESCAPE, never as a literal NUL: a
// literal one makes git, grep and file(1) treat this source as binary, and makes
// codeindex drop the file from its own index (readText sniffs a NUL as "binary").
// Same character at runtime; see src/graph.ts, which learned this the hard way.
// Only has to be a character no path or edge kind can contain.
const SEP = "\u0000";

// Symbol kinds that only POINT at a definition elsewhere; they must never be an
// edge endpoint, or a barrel would absorb the neighborhood of everything it
// re-exports. Same set the caller index and the graph builder use.
const REFERENCE_KINDS = new Set(["reexport", "reexport-all", "default"]);

export type SymbolEdgeKind = "calls" | "extends" | "implements";

export interface SymbolNode {
  /** Stable id: `file#Parent/name` for a member, `file#name` otherwise. */
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine?: number;
  exported: boolean;
  doc?: string;
  signature?: string;
}

export interface SymbolEdge {
  from: string; // node id
  to: string; // node id
  kind: SymbolEdgeKind;
  /** How many distinct call sites back a `calls` edge. Always 1 for inheritance. */
  weight: number;
}

export interface SymbolGraph {
  nodes: Map<string, SymbolNode>;
  edges: SymbolEdge[];
  /** id → outgoing edges, and id → incoming; both sorted. */
  out: Map<string, SymbolEdge[]>;
  in: Map<string, SymbolEdge[]>;
  /** name → every node id declaring it, for looking a symbol up by bare name. */
  byName: Map<string, string[]>;
}

export function symbolId(s: Pick<CodeSymbol, "file" | "name" | "parent">): string {
  return s.parent ? `${s.file}#${s.parent}/${s.name}` : `${s.file}#${s.name}`;
}

function toNode(s: CodeSymbol): SymbolNode {
  return {
    id: symbolId(s),
    name: s.name,
    kind: s.kind,
    file: s.file,
    line: s.line,
    ...(s.endLine !== undefined ? { endLine: s.endLine } : {}),
    exported: s.exported,
    ...(s.doc ? { doc: s.doc } : {}),
    ...(s.signature ? { signature: s.signature } : {}),
  };
}

/**
 * Build the symbol graph. `importPairs` is the resolved-import pair set the call
 * binder uses for corroboration — pass the memoised one (derived.ts) so this
 * shares work with the rest of a session.
 *
 * Deterministic: edges are aggregated into a Map keyed by (from, to, kind) and
 * sorted before return, so two builds of one scan agree exactly.
 */
export function buildSymbolGraph(scan: RepoScan, importPairs: Set<string>): SymbolGraph {
  const nodes = new Map<string, SymbolNode>();
  // Per-file symbol lists, filtered once and reused for every call site in that
  // file (the reason enclosingAmong is factored out of enclosingSymbol).
  const perFile = new Map<string, CodeSymbol[]>();
  // Callable definitions by name, deduped per (name, file).
  const defs = new Map<string, CodeSymbol[]>();
  const defSeen = new Set<string>();

  for (const f of scan.files) {
    const usable: CodeSymbol[] = [];
    for (const s of f.symbols) {
      if (REFERENCE_KINDS.has(s.kind)) continue;
      usable.push(s);
      nodes.set(symbolId(s), toNode(s));
      if (!s.exported) continue;
      const key = `${s.name} ${s.file}`;
      if (defSeen.has(key)) continue;
      defSeen.add(key);
      let arr = defs.get(s.name);
      if (!arr) defs.set(s.name, (arr = []));
      arr.push(s);
    }
    perFile.set(f.rel, usable);
  }

  const agg = new Map<string, SymbolEdge>();
  const add = (from: string, to: string, kind: SymbolEdgeKind): void => {
    if (from === to) return; // self-recursion is not a navigable hop
    const key = `${from}${SEP}${to}${SEP}${kind}`;
    const prev = agg.get(key);
    if (prev) prev.weight += 1;
    else agg.set(key, { from, to, kind, weight: 1 });
  };

  // --- calls: enclosing declaration → resolved callee declaration -----------
  for (const f of scan.files) {
    if (!f.calls?.length) continue;
    const family = familyOf(f.lang);
    const own = perFile.get(f.rel) ?? [];
    const localByName = new Map<string, CodeSymbol>();
    for (const s of own) if (!localByName.has(s.name)) localByName.set(s.name, s);

    for (const c of f.calls) {
      const caller = enclosingAmong(own, c.line);
      if (!caller) continue; // a call at file scope has no symbol to attribute it to

      // Same-file definition shadows anything elsewhere — mirrors buildCallerIndex.
      const local = localByName.get(c.name);
      if (local) {
        if (local.line !== c.line) add(symbolId(caller), symbolId(local), "calls");
        continue;
      }
      const cands = (defs.get(c.name) ?? []).filter((d) => familyOf(d.lang) === family && d.file !== f.rel);
      if (!cands.length) continue;
      const imported = cands.filter((d) => importPairs.has(`${f.rel}|${d.file}`));
      // JS/TS keeps its import gate: a bare identifier is too ambiguous to bind
      // on name alone, and a wrong edge here misleads an impact analysis.
      const pool = imported.length ? imported : family === "js" ? [] : cands;
      if (!pool.length) continue;
      const chosen = pickCandidate(f.rel, pool.map((d): Cand => ({ file: d.file, lang: d.lang })));
      if (!chosen) continue;
      const target = pool.find((d) => d.file === chosen.file)!;
      add(symbolId(caller), symbolId(target), "calls");
    }
  }

  // --- inheritance: subtype declaration → supertype declaration -------------
  const typeIdByNameFile = new Map<string, string>();
  for (const node of nodes.values()) typeIdByNameFile.set(`${node.name} ${node.file}`, node.id);
  for (const r of resolveRelations(scan, importPairs)) {
    const from = typeIdByNameFile.get(`${r.from} ${r.fromFile}`);
    const to = typeIdByNameFile.get(`${r.to} ${r.toFile}`);
    if (from && to) add(from, to, r.kind);
  }

  const edges = [...agg.values()].sort(
    (a, b) => byStr(a.from, b.from) || byStr(a.kind, b.kind) || byStr(a.to, b.to),
  );

  const out = new Map<string, SymbolEdge[]>();
  const inc = new Map<string, SymbolEdge[]>();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e);
  }

  const byName = new Map<string, string[]>();
  for (const id of [...nodes.keys()].sort(byStr)) {
    const n = nodes.get(id)!;
    (byName.get(n.name) ?? byName.set(n.name, []).get(n.name)!).push(id);
  }

  return { nodes, edges, out, in: inc, byName };
}

export type Direction = "out" | "in" | "both";

export interface Neighborhood {
  /** Every declaration matching the requested name — the walk starts from all of them. */
  root: SymbolNode[];
  /** Reached nodes with the hop count at which each was first seen (root = 0). */
  nodes: (SymbolNode & { depth: number })[];
  edges: SymbolEdge[];
  /** True when the node cap stopped the walk short. */
  truncated?: true;
}

const MAX_DEPTH = 5;
const MAX_NODES = 400;

/**
 * The bounded neighborhood of a symbol. Breadth-first, so `depth` is the true
 * hop distance; cycle-safe; capped at MAX_NODES with `truncated` set rather than
 * quietly returning a partial answer.
 */
export function neighborhood(
  graph: SymbolGraph,
  name: string,
  opts: { depth?: number; direction?: Direction } = {},
): Neighborhood {
  const depthLimit = Math.max(1, Math.min(opts.depth ?? 2, MAX_DEPTH));
  const direction = opts.direction ?? "both";

  // A bare name, a `Parent/name` path, or a full `file#Parent/name` id.
  const rootIds =
    graph.nodes.has(name)
      ? [name]
      : (graph.byName.get(name) ??
        [...graph.nodes.keys()].filter((id) => id.endsWith(`#${name}`)));
  const root = rootIds.map((id) => graph.nodes.get(id)!).filter(Boolean);
  if (!root.length) return { root: [], nodes: [], edges: [] };

  const depthOf = new Map<string, number>();
  for (const id of rootIds) depthOf.set(id, 0);
  const picked = new Map<string, SymbolEdge>();
  let frontier = [...rootIds];
  let truncated = false;

  for (let d = 1; d <= depthLimit && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const step = (edges: SymbolEdge[] | undefined, other: (e: SymbolEdge) => string): void => {
        for (const e of edges ?? []) {
          picked.set(`${e.from}${SEP}${e.to}${SEP}${e.kind}`, e);
          const o = other(e);
          if (depthOf.has(o)) continue;
          if (depthOf.size >= MAX_NODES) {
            truncated = true;
            continue;
          }
          depthOf.set(o, d);
          next.push(o);
        }
      };
      if (direction !== "in") step(graph.out.get(id), (e) => e.to);
      if (direction !== "out") step(graph.in.get(id), (e) => e.from);
    }
    frontier = next;
  }

  const nodes = [...depthOf.entries()]
    .map(([id, depth]) => ({ ...graph.nodes.get(id)!, depth }))
    .sort((a, b) => a.depth - b.depth || byStr(a.file, b.file) || byStr(a.name, b.name));
  // Keep only edges whose BOTH ends are inside the returned set, so the result
  // is a self-contained subgraph rather than one with dangling references.
  const edges = [...picked.values()]
    .filter((e) => depthOf.has(e.from) && depthOf.has(e.to))
    .sort((a, b) => byStr(a.from, b.from) || byStr(a.kind, b.kind) || byStr(a.to, b.to));

  return { root, nodes, edges, ...(truncated ? { truncated: true as const } : {}) };
}
