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
  CodeLiteral,
  RawRef,
  RawRelation,
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
export { scanRepo, scanSummary } from "./scan.js";
export type { RepoScan, ScanOptions, ScanSummary, ExtractedRecord } from "./scan.js";
export { keptCodeFiles, buildCodeRecord } from "./scan.js";
// Reusing a persisted `.codeindex/` index instead of rebuilding it. The MCP
// server and every CLI read command go through this; a consumer that vendors
// the engine gets the same shortcut. Every function degrades to undefined
// (= "build it yourself") rather than throwing.
export { preloadSession, preloadArtifacts, readPersistedIndex, toCacheMap, INDEX_DIR } from "./preload.js";
export type { PersistedMeta, PersistedCacheEntry, PersistedCacheMap } from "./preload.js";
// Parallel extraction. scanRepoParallel is scanRepo with the code files
// extracted across worker_threads; it returns the same RepoScan, byte-for-byte,
// and degrades to the sequential path whenever workers are unavailable.
//
// `runExtractWorker` MUST stay exported: the worker bootstrap imports it BY NAME
// off this barrel, and a missing export is indistinguishable from "this is not
// the engine" — the pool would silently run sequential forever.
export { scanRepoParallel, extractInParallel, runExtractWorker, workerCount } from "./pool.js";
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
export { extractTags, tagsQueryStatus } from "./ast/tags.js";
export type { TagDefinition, TagsQueryStatus } from "./ast/tags.js";
// Grammars resolution + the slim pull/cache tier (v2.14.0): resolve the wasm
// dir across bundle-adjacent → env → shared cache → none, and fetch the
// committed wasms into the shared cache when none ship next to the bundle
// (`codeindex grammars pull|status`). Additive; opt-in; offline-safe.
export { resolveGrammarsDir, resolveGrammarsTier, sharedGrammarsCacheDir } from "./ast/loader.js";
export { CORE_GRAMMARS, EXTENDED_GRAMMARS, EXT_GRAMMAR } from "./ast/loader.js";
export type { GrammarsTier, GrammarsTierName } from "./ast/loader.js";
export {
  DEFAULT_GRAMMARS_URL,
  resolveGrammarsPullTarget,
  fetchGrammarsTarball,
  fetchExpectedSha256,
  extractTarInto,
  extractGrammarsTarball,
  pullGrammars,
} from "./ast/grammars-pull.js";
export type { GrammarsPullTarget, GrammarsPullResult } from "./ast/grammars-pull.js";
// The one-call AST warm-up for consumers. `scanRepo` is synchronous and cannot
// warm the grammars itself, so a consumer that never awaits this stays on the
// regex tier forever — silently. Call it once at the CLI entry.
export { warmGrammars } from "./ast/warm.js";
export type { WarmGrammarsResult, WarmGrammarsOptions } from "./ast/warm.js";

// Resolution + modules + graph tier.
export { buildResolveContext, resolveImport, resolveDocLink } from "./resolve.js";
export type { Resolution, ResolveContext } from "./resolve.js";
export { buildModules, isTestFile, tierForPath } from "./modules.js";
export type { ModuleInfo } from "./modules.js";
export { buildGraph, uniqueSymbolDefs } from "./graph.js";
export { resolveCallEdges } from "./calls.js";
export {
  resolveRelations,
  resolveRelationEdges,
  buildTypeHierarchy,
  implementationsOf,
  typeEntry,
} from "./relations.js";
export type { ResolvedRelation, TypeHierarchyEntry, HierarchyRef } from "./relations.js";
export { buildSymbolGraph, neighborhood, symbolId } from "./symbolgraph.js";
export type { SymbolGraph, SymbolNode, SymbolEdge, SymbolEdgeKind, Neighborhood, Direction } from "./symbolgraph.js";
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
export { searchIndex, explainQuery, subtokens } from "./bm25.js";
export type { SearchOptions, SearchResult, ExplainedSearch, QueryExplanation, QueryVerdict, TermDiagnostic } from "./bm25.js";

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

// Optional LSP tier: type-aware references from a language server the user
// configures, annotating the static answer rather than replacing it.
//
// NOTHING HERE IS REACHABLE FROM THE ARTIFACT PIPELINE — src/pipeline.ts does
// not import src/lsp/, and tests/lsp-boundary.test.ts proves it by building
// this repo's own graph and checking the import closure. That is what makes
// "the LSP tier cannot change graph.json/symbols.json bytes" a property of the
// module graph rather than a promise in a comment.
export { lspStatus, referencesWithLsp } from "./lsp/index.js";
export { loadLspConfig, parseLspConfig, resolveLspConfigPath, serverForLang } from "./lsp/config.js";
export { openLspSession, LspTimeout } from "./lsp/client.js";
export { spawnLspTransport } from "./lsp/spawn.js";
export { createFramer, encodeMessage, fileUri, relFromUri, locationsToRefs, MAX_FRAME_BYTES } from "./lsp/protocol.js";
export { agreementOf, columnOfSymbol, lspUnavailable } from "./lsp/refs.js";
export type { LspConfig, LspServerConfig, LspConfigSource } from "./lsp/config.js";
export type { LspStatus, LspServerStatus } from "./lsp/index.js";
export type { LspTransport, LspSession, LspSessionOptions, LspCapabilities } from "./lsp/client.js";
export type { LspReferences, LspBlock, LspAgreement } from "./lsp/refs.js";
export type { LspRef, LspMessage } from "./lsp/protocol.js";

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
export { findLiteralDuplications } from "./literals.js";
export type {
  LiteralDuplication,
  LiteralFamily,
  LiteralSite,
  LiteralsOptions,
  LiteralsReport,
} from "./literals.js";
export { symbolComplexity, riskHotspots, complexityOfSource } from "./complexity.js";
export type { SymbolComplexity, RiskHotspot } from "./complexity.js";
export { renderMermaid, renderMermaidClustered } from "./viz.js";
export type { MermaidOptions, ClusteredMermaidOptions, ClusteredMermaidResult } from "./viz.js";

// Graph traversal: reverse-dependency closure ("what breaks if I change this")
// and bidirectional neighbourhood walks. Pure functions of a Graph, so a
// consumer holding a persisted graph.json answers both without a rescan.
export { impactOf, neighborsOf, reverseClosure, hubThreshold } from "./traverse.js";
export type { ImpactResult, ImpactedFile, NeighborResult, NeighborLink } from "./traverse.js";

// Diff review: git diff -> enclosing symbols -> blast radius -> risk-scored,
// reasons-first panel. `computeDelta` is the pure core (no git, no fs);
// `deltaFor` adds the git plumbing against a graph the caller supplies.
export { computeDelta, deltaFor, formatDeltaPanel, symbolsInHunks, RISK_WEIGHTS, DEFAULT_DELTA_DEPTH } from "./delta.js";
export type { DeltaOptions, DeltaResult, DeltaError, DeltaModule, DeltaChange, ChangedSymbol } from "./delta.js";
export type { RepoMapOptions } from "./repomap.js";

// MCP server over stdio (also reachable as `engine.mjs mcp`).
export { runMcpServer } from "./mcp.js";
export type { McpServerOptions } from "./mcp.js";

// Command rewriting: an expensive tree-wide search → its indexed equivalent.
// Exported so a host can decide for itself rather than shelling out to
// `engine.mjs rewrite` (same conservative refusal semantics either way).
// Only the decision function is public — the tokenizer/quoter are internal
// details, and `tokenize` is already taken here by the wordpiece tokenizer.
export { rewriteCommand } from "./rewrite.js";

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
