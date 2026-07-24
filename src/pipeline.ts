import type { Graph, SymbolIndex } from "./types.js";
import { scanRepo, type RepoScan, type ScanOptions } from "./scan.js";
import { buildResolveContext } from "./resolve.js";
import { buildModules } from "./modules.js";
import { buildGraph } from "./graph.js";
import { detectCommunities } from "./community.js";
import { applyCentrality } from "./centrality.js";
import { computeTestMap } from "./tests-map.js";
import { computeSurprises } from "./surprise.js";
import { buildSymbolIndex, computeSymbolRefs } from "./render/symbols-json.js";

export interface BuildIndexOptions extends ScanOptions {
  // Stamped into the graph a consumer persists — lets it carry its own
  // version/schema instead of the engine's (see buildGraph).
  meta?: { version?: string; schemaVersion?: number };
  // Community ids from a previous build (manifest `communities` shape), so an
  // unchanged partition keeps stable ids across rebuilds.
  previousCommunities?: Record<string, string[]>;
}

export interface IndexArtifacts {
  scan: RepoScan;
  graph: Graph;
  symbols: SymbolIndex;
}

// The full deterministic pipeline in one call: scan → resolve → group → graph →
// communities → centrality → tests-map → surprises → symbol index. Mirrors the
// exact composition (and mutation order — it matters for byte-stable output)
// that ultraindex's build performs before its prose rendering.
export function buildIndexArtifacts(repo: string, opts: BuildIndexOptions = {}): IndexArtifacts {
  return buildArtifactsFromScan(scanRepo(repo, opts), opts);
}

// Everything downstream of the scan: resolve → group → graph → communities →
// centrality → tests-map → surprises → symbol index, in the same (load-bearing)
// mutation order as buildIndexArtifacts — which is now just scanRepo + this.
// Lets a caller that already holds a RepoScan build the artifacts without
// re-walking the repo.
export function buildArtifactsFromScan(scan: RepoScan, opts: BuildIndexOptions = {}): IndexArtifacts {
  const ctx = buildResolveContext(scan);
  const { modules, moduleOf } = buildModules(scan);
  const graph = buildGraph(scan, ctx, modules, moduleOf, opts.meta);

  const communities = detectCommunities(graph.modules, graph.moduleEdges, opts.previousCommunities);
  for (const m of graph.modules) {
    const id = communities.get(m.slug);
    if (id !== undefined) m.community = id;
  }

  applyCentrality(graph);

  const testMap = computeTestMap(graph);
  for (const f of graph.files) {
    if (testMap.testFiles.has(f.rel)) f.testFile = true;
  }
  for (const m of graph.modules) {
    const t = testMap.testedByModule.get(m.slug);
    if (t?.length) m.testedBy = t;
  }

  const surprises = computeSurprises(graph);
  if (surprises.length) graph.surprises = surprises;

  const symbols = buildSymbolIndex(scan, computeSymbolRefs(scan));
  return { scan, graph, symbols };
}
