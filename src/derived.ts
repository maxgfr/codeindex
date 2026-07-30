// Per-scan derived-structure cache (INTERNAL — deliberately NOT exported from
// the src/engine.ts barrel). Several public entry points independently
// recompute the same expensive structures from the same RepoScan object:
// findReferences, findDeadCode and the pipeline each rebuild the caller index
// / symbol refs; computeImportPairs rebuilds the resolve context; searchIndex
// rebuilds the BM25 documents; riskHotspots re-reads every code file. This
// module memoizes those structures once per scan, keyed by RepoScan object
// identity in a WeakMap — a scan's cache lives exactly as long as the scan
// itself, and two scans (even of the same repo) never share entries.
//
// Determinism: every builder memoized here is a pure function of the scan
// (plus, for the resolve context and per-file complexity, the on-disk bytes
// the scan describes), so a cache hit returns exactly what a recompute would —
// artifacts stay byte-identical; only repeated work disappears.
//
// Sharing contract: accessors return the SAME object on every call for a
// given scan. Callers must treat the results as READ-ONLY and copy anything
// they hand to a consumer that owns its result (findReferences copies
// callSites; computeImportPairs returns a fresh Set) — a consumer mutation
// reaching a cached object would poison every later query on that scan.
//
// Only the DEFAULT (precision) caller index is memoized: recall-mode variants
// take options, and buildCallerIndex's public path keeps building a fresh
// index per call (it only shares the memoized import pairs).
//
// Import cycles: callers.ts / bm25.ts / complexity.ts import their accessor
// from here while this module imports their builders — function-level cycles
// only (no module-evaluation-time cross-calls), which Node ESM and esbuild
// resolve safely.
import { join } from "node:path";
import type { Edge } from "./types.js";
import type { RepoScan } from "./scan.js";
import { buildResolveContext, resolveImport, type ResolveContext } from "./resolve.js";
import { uniqueSymbolDefs } from "./graph.js";
import { computeSymbolRefs } from "./render/symbols-json.js";
import { buildCallerIndex, type CallerIndex } from "./callers.js";
import { buildTypeHierarchy, type TypeHierarchyEntry } from "./relations.js";
import { buildSymbolGraph, type SymbolGraph } from "./symbolgraph.js";
import { buildDocs, buildStemIndex, buildTrigramIndex, type Doc } from "./bm25.js";
import { pagerankOf } from "./centrality.js";
import { complexityOfSource } from "./complexity.js";
import { readText } from "./walk.js";

interface DerivedCache {
  resolveCtx?: ResolveContext;
  importPairs?: Set<string>; // `${from}|${to}` resolved-import pairs
  uniqueDefs?: Map<string, string>; // uniqueSymbolDefs(scan)
  symbolRefs?: Map<string, Set<string>>; // computeSymbolRefs(scan)
  callerIndex?: CallerIndex; // DEFAULT precision opts only — never recall mode
  bm25?: { docs: Doc[]; trigrams?: Map<string, Set<string>>; stems?: Map<string, string[]> };
  hierarchy?: Map<string, TypeHierarchyEntry>;
  symbolGraph?: SymbolGraph;
  fileComplexity?: Map<string, number>; // rel → whole-file branch count + 1 (code files)
  importPagerank?: Map<string, number>; // rel → PageRank over the resolved import graph
}

const caches = new WeakMap<RepoScan, DerivedCache>();

function cacheFor(scan: RepoScan): DerivedCache {
  let c = caches.get(scan);
  if (!c) caches.set(scan, (c = {}));
  return c;
}

export function resolveContextFor(scan: RepoScan): ResolveContext {
  const c = cacheFor(scan);
  return (c.resolveCtx ??= buildResolveContext(scan));
}

// The same pair set computeImportPairs (callers.ts) historically built —
// computed here against the memoized resolve context so the public function
// can delegate (returning a fresh Set) without a recompute per call.
export function importPairsFor(scan: RepoScan): Set<string> {
  const c = cacheFor(scan);
  if (!c.importPairs) {
    const ctx = resolveContextFor(scan);
    const pairs = new Set<string>();
    for (const f of scan.files) {
      for (const ref of f.refs) {
        if (ref.kind !== "import") continue;
        const r = resolveImport(f.rel, f.ext, ref.spec, ctx);
        if (r.kind === "resolved" && r.target !== f.rel) pairs.add(`${f.rel}|${r.target}`);
      }
    }
    c.importPairs = pairs;
  }
  return c.importPairs;
}

// Seed the import-pair cache with a set buildGraph already resolved.
//
// buildGraph resolves every import in the repo to draw its `import` edges and
// keeps the resolved pairs to suppress redundant `use` edges — the exact set
// importPairsFor computes. Without this, the pipeline resolved every import
// twice: once in buildGraph, once again the first time anything asked for the
// caller index / references / dead code.
//
// Guarded on resolve-context identity: buildGraph is a public export a consumer
// may call with its own context, and pairs resolved under a foreign context must
// never masquerade as this scan's. Never overwrites an existing entry.
export function publishImportPairs(scan: RepoScan, ctx: ResolveContext, pairs: Set<string>): void {
  const c = caches.get(scan);
  if (!c || c.resolveCtx !== ctx || c.importPairs) return;
  c.importPairs = pairs;
}

export function uniqueDefsFor(scan: RepoScan): Map<string, string> {
  const c = cacheFor(scan);
  return (c.uniqueDefs ??= uniqueSymbolDefs(scan));
}

export function symbolRefsFor(scan: RepoScan): Map<string, Set<string>> {
  const c = cacheFor(scan);
  return (c.symbolRefs ??= computeSymbolRefs(scan));
}

// Default (precision) caller index only. Recall-mode indexes are option-
// dependent and stay unmemoized on buildCallerIndex's public path.
export function callerIndexFor(scan: RepoScan): CallerIndex {
  const c = cacheFor(scan);
  return (c.callerIndex ??= buildCallerIndex(scan, importPairsFor(scan)));
}

// The repo-wide type hierarchy. Resolving it walks every relation against the
// symbol table, so `type_hierarchy` and `implementations` in the same session
// share one build.
export function hierarchyFor(scan: RepoScan): Map<string, TypeHierarchyEntry> {
  const c = cacheFor(scan);
  return (c.hierarchy ??= buildTypeHierarchy(scan, importPairsFor(scan)));
}

// The symbol-level call/inheritance graph. Built once per scan: a session asking
// for several neighborhoods pays for the graph once.
export function symbolGraphFor(scan: RepoScan): SymbolGraph {
  const c = cacheFor(scan);
  return (c.symbolGraph ??= buildSymbolGraph(scan, importPairsFor(scan)));
}

export function bm25DocsFor(scan: RepoScan): Doc[] {
  const c = cacheFor(scan);
  return (c.bm25 ??= { docs: buildDocs(scan) }).docs;
}

// The corpus-vocabulary trigram index stays LAZY: built only when searchIndex
// first meets a zero-df query term (the pre-cache behavior), then cached so
// later fuzzy queries on the same scan skip the rebuild.
export function bm25TrigramsFor(scan: RepoScan): Map<string, Set<string>> {
  const c = cacheFor(scan);
  const bm25 = (c.bm25 ??= { docs: buildDocs(scan) });
  return (bm25.trigrams ??= buildTrigramIndex(bm25.docs));
}

// A file's PageRank over the resolved IMPORT graph — search's structural prior.
//
// Not the graph builder's pagerank: that one needs the full link-graph (calls,
// use, mention, communities, centrality), which is far more work than a ranking
// prior justifies. This runs the same `pagerankOf` over the import pairs the
// resolve context already produced, so a session that has asked for callers or
// dead code pays nothing extra.
export function importPagerankFor(scan: RepoScan): Map<string, number> {
  const c = cacheFor(scan);
  if (!c.importPagerank) {
    const ids = scan.files.map((f) => f.rel);
    const edges: Edge[] = [];
    for (const pair of importPairsFor(scan)) {
      const sep = pair.indexOf("|");
      edges.push({ from: pair.slice(0, sep), to: pair.slice(sep + 1), kind: "import", weight: 1 });
    }
    c.importPagerank = pagerankOf(ids, edges);
  }
  return c.importPagerank;
}

// Corpus vocabulary grouped by morphological stem. LAZY for the same reason the
// trigram index is: a query whose every term already matches never builds it.
export function bm25StemsFor(scan: RepoScan): Map<string, string[]> {
  const c = cacheFor(scan);
  const bm25 = (c.bm25 ??= { docs: buildDocs(scan) });
  return (bm25.stems ??= buildStemIndex(bm25.docs));
}

// Whole-file branch counts for every code file (riskHotspots' per-file
// complexity). The FIRST call still reads each code file from disk — accepted;
// repeat calls on the same scan become lookups.
export function fileComplexityFor(scan: RepoScan): Map<string, number> {
  const c = cacheFor(scan);
  if (!c.fileComplexity) {
    const m = new Map<string, number>();
    for (const f of scan.files) {
      if (f.kind !== "code") continue;
      m.set(f.rel, complexityOfSource(readText(join(scan.root, f.rel))));
    }
    c.fileComplexity = m;
  }
  return c.fileComplexity;
}
