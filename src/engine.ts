// codeindex — the shared, self-contained repo-indexing engine.
//
// This file is the public contract: everything a consumer may import from the
// vendored bundle is re-exported here, and nothing else. The bundle is dual-use:
// import it as an ESM library (consumers inline it into their own single-file
// builds), or run it directly (`node engine.mjs <cmd>`) via the guard at the
// bottom. Zero runtime dependencies; the tree-sitter AST tier activates only
// when a grammars/ directory is present next to the bundle (regex tier
// otherwise — see ast/loader.ts).

// Version constants — see types.ts for bump rules.
export { ENGINE_VERSION, SCHEMA_VERSION, EXTRACTOR_VERSION } from "./types.js";
export type {
  FileKind,
  EdgeKind,
  Tier,
  CodeSymbol,
  RawRef,
  FileRecord,
  FileNode,
  ModuleNode,
  Edge,
  Graph,
  SurpriseEdge,
  SymbolIndex,
} from "./types.js";

// Files tier: walk, read, filter, classify.
export { walk, readText, DEFAULT_MAX_FILES } from "./walk.js";
export type { WalkOptions, WalkedFile, WalkResult } from "./walk.js";
export { scanRepo } from "./scan.js";
export type { RepoScan, ScanOptions } from "./scan.js";
export { compileGlobs } from "./glob.js";
export { parseGitignore, isIgnored } from "./ignore.js";
export type { IgnoreRule } from "./ignore.js";
export { classify, isCode, isDoc, MARKDOWN_EXT } from "./classify.js";
export { categorize } from "./categorize.js";
export type { FileCategory } from "./categorize.js";
export { extractSymbols, languageOf, extToLang } from "./lang/registry.js";

// Extraction tier (AST-preferred with regex fallback; imports always regex).
export { extractCode } from "./extract/code.js";
export type { CodeInfo } from "./extract/code.js";
export { extractMarkdown } from "./extract/markdown.js";
export type { MarkdownInfo } from "./extract/markdown.js";

// AST tier (optional — a no-op without the grammar wasm sidecar).
export { ensureGrammars, allGrammarKeys, grammarKeysForExts, grammarKeyForExt, grammarReady } from "./ast/loader.js";
export { extractAst } from "./ast/extract.js";

// Resolution + modules + graph tier.
export { buildResolveContext, resolveImport, resolveDocLink } from "./resolve.js";
export type { Resolution, ResolveContext } from "./resolve.js";
export { buildModules, isTestFile, tierForPath } from "./modules.js";
export type { ModuleInfo } from "./modules.js";
export { buildGraph, uniqueSymbolDefs } from "./graph.js";
export { resolveCallEdges } from "./calls.js";
export { buildCallerIndex, buildRawCallerIndex, enclosingSymbol, computeImportPairs } from "./callers.js";
export { symbolsOverview, findSymbol, findReferences } from "./query.js";
export { resolveUniqueSymbol, replaceSymbolBody, insertAfterSymbol, insertBeforeSymbol } from "./edit.js";
export type { EditResult } from "./edit.js";
export { writeMemory, readMemory, deleteMemory, listMemories } from "./memory.js";
export type { SymbolMatch, FindSymbolOptions, SymbolReferences } from "./query.js";
export type { CallerIndex, CallerEntry, CallerSite } from "./callers.js";
export { detectWorkspaces } from "./workspaces.js";
export type { WorkspaceInfo, WorkspacePackage, WorkspaceKind } from "./workspaces.js";

// Graph analytics.
export { applyCentrality, pagerankOf, betweennessOf } from "./centrality.js";
export { detectCommunities, communityOf } from "./community.js";
export { computeTestMap, isTestPath, testsForModule, untestedModules } from "./tests-map.js";
export type { TestMap } from "./tests-map.js";
export { computeSurprises, isSurprising } from "./surprise.js";

// Symbol index + machine renderers (render-to-string; consumers own persistence).
export { buildSymbolIndex, computeSymbolRefs, renderSymbolsJson } from "./render/symbols-json.js";
export { renderGraphJson } from "./render/graph-json.js";
export { renderScip } from "./render/scip.js";
export type { RenderScipOptions } from "./render/scip.js";

// One-call pipeline (buildArtifactsFromScan: the scan-onward half, for callers
// that already hold a RepoScan).
export { buildIndexArtifacts, buildArtifactsFromScan } from "./pipeline.js";
export type { BuildIndexOptions, IndexArtifacts } from "./pipeline.js";

// Git utilities.
export {
  headCommit,
  isGitWorktree,
  resolveBaseRef,
  diffFiles,
  diffHunks,
  untrackedFiles,
  gitChurn,
  changedSince,
} from "./git.js";
export type { DiffFile, DiffSpec, Hunk } from "./git.js";

// Repo text search (ripgrep when available, pure-JS fallback otherwise).
export { grepRepo } from "./grep.js";
export type { SearchHit, GrepOptions } from "./grep.js";

// Keyless BM25 lexical search over symbols/paths/headings/summaries (issue #4).
export { searchIndex, subtokens } from "./bm25.js";
export type { SearchOptions, SearchResult } from "./bm25.js";

// Deterministic static-embedding tier (v2.10.0): a keyless, byte-deterministic
// semantic search, opt-in by model-asset presence (models NEVER ship in the
// tarball). EMBED_VERSION is dedicated to the embeddings.bin sidecar and is
// independent of SCHEMA_VERSION / EXTRACTOR_VERSION.
export {
  EMBED_VERSION,
  resolveEmbedModelDir,
  hasEmbedModel,
  loadEmbedModel,
  resolveEmbedPullUrl,
} from "./embed/model.js";
export type { StaticEmbedModel, EmbedPullTarget } from "./embed/model.js";
export { encode, quantize, tokenize, wordpiece, basicTokenize, roundHalfToEven, intDot } from "./embed/encode.js";
export { buildEmbeddingIndex, serializeEmbeddings, deserializeEmbeddings, embeddingUnits } from "./embed/index.js";
export type { EmbeddingIndex, EmbeddingRecord, EmbeddingUnit } from "./embed/index.js";
export { searchSemantic } from "./embed/search.js";
export type { SemanticSearchOptions, SemanticSearchResult } from "./embed/search.js";
// HTTP endpoint tier (v2.11.0 — the "rich" tier). The engine is a fetch consumer
// of a containerized embedding server (CODEINDEX_EMBED_ENDPOINT): float vectors
// run through the SAME L2+int8 quantize pipeline, then the same integer ranking.
// Deterministic PER IMAGE DIGEST (not byte-golden). The library never
// orchestrates docker — `codeindex embed serve` (CLI) only prints/runs it.
export {
  embedViaEndpoint,
  resolveEmbedEndpoint,
  embedEndpointUrl,
  healthzUrl,
  probeEndpoint,
  encodeQueryViaEndpoint,
  buildEndpointIndex,
} from "./embed/endpoint.js";
export type { EmbedEndpointOptions } from "./embed/endpoint.js";

// Architecture rules: forbidden edges + cycles/orphans builtins (issue #4).
export { checkRules, parseRules } from "./rules.js";
export type { ArchRule, ForbiddenEdgeRule, BuiltinRule, RuleSeverity, RuleViolation } from "./rules.js";

// Caller-index recall mode (issue #7) — options for buildCallerIndex above.
export type { CallerIndexOptions } from "./callers.js";

// Raw-recall caller index (issue #8) — ungated, def-resolution-free companion
// to buildCallerIndex above; see its JSDoc in callers.ts for the contract.
export type { RawCallerIndex, RawCallerSite } from "./callers.js";

// Behavioral analytics (git-history mining) + the token-budgeted repo map.
export { changeCoupling, rankHotspots } from "./coupling.js";
export type { ChangeCoupling, CouplingOptions, Hotspot } from "./coupling.js";
export { renderRepoMap } from "./repomap.js";
export { findDeadCode } from "./deadcode.js";
export type { DeadSymbol } from "./deadcode.js";
export { symbolComplexity, riskHotspots, complexityOfSource } from "./complexity.js";
export type { SymbolComplexity, RiskHotspot } from "./complexity.js";
export { renderMermaid } from "./viz.js";
export type { MermaidOptions } from "./viz.js";
export type { RepoMapOptions } from "./repomap.js";

// MCP server over stdio (also reachable as `engine.mjs mcp`).
export { runMcpServer } from "./mcp.js";
export type { McpServerOptions } from "./mcp.js";

// General-purpose helpers shared by consumers (deterministic, dependency-free).
export { sha1, shortHash } from "./hash.js";
export { byStr, byKey } from "./sort.js";
export {
  sh,
  have,
  slugify,
  clip,
  clipInline,
  escapeRegExp,
  foldText,
  keywords,
  rankedKeywords,
  rrf,
} from "./util.js";
export type { ShResult } from "./util.js";

// CLI entry — exported, never self-triggered. This module MUST stay free of
// top-level side effects: consumers re-bundle engine.mjs into their own
// single-file CLIs, where a "am I the main module?" guard would misfire
// (import.meta.url inside their bundle IS their bundle) and hijack their argv.
// The standalone CLI/MCP entry is the static wrapper scripts/cli.mjs.
export { runCli } from "./engine-cli.js";
