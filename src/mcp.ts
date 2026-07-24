// MCP (Model Context Protocol) server over stdio — hand-rolled JSON-RPC 2.0 so
// the engine stays zero-dependency. Newline-delimited JSON messages, protocol
// 2024-11-05 (compatible with later revisions' initialize handshake). Exposes
// the engine's read-only indexing capabilities as MCP tools; every tool takes a
// `repo` path and returns JSON text content.
//
// Register in an MCP client as:  node scripts/engine.mjs mcp
import { statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ENGINE_VERSION, type FileRecord } from "./types.js";
import { ensureGrammars, allGrammarKeys } from "./ast/loader.js";
import { buildArtifactsFromScan, type IndexArtifacts } from "./pipeline.js";
import { renderGraphJson } from "./render/graph-json.js";
import { scanRepo, type RepoScan, type ScanOptions } from "./scan.js";
import { buildCallerIndex } from "./callers.js";
import { detectWorkspaces } from "./workspaces.js";
import { gitChurn } from "./git.js";
import { grepRepo } from "./grep.js";
import { changeCoupling, rankHotspots } from "./coupling.js";
import { renderRepoMap } from "./repomap.js";
import { findDeadCode } from "./deadcode.js";
import { symbolComplexity, riskHotspots } from "./complexity.js";
import { renderMermaid } from "./viz.js";
import { symbolsOverview, findSymbol, findReferences } from "./query.js";
import { replaceSymbolBody, insertAfterSymbol, insertBeforeSymbol } from "./edit.js";
import { writeMemory, readMemory, deleteMemory, listMemories } from "./memory.js";
import { searchIndex } from "./bm25.js";
import { checkRules, parseRules } from "./rules.js";
import { EMBED_VERSION, resolveEmbedModelDir, loadEmbedModel, type StaticEmbedModel } from "./embed/model.js";
import { buildEmbeddingIndex, type EmbeddingIndex } from "./embed/index.js";
import { searchSemantic } from "./embed/search.js";
import { resolveEmbedEndpoint, buildEndpointIndex, encodeQueryViaEndpoint, probeEndpoint } from "./embed/endpoint.js";
import { sha1 } from "./hash.js";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const repoProp = { repo: { type: "string", description: "Absolute path to the repository root" } };
const scopeProps = {
  scope: { type: "string", description: "Restrict to one directory (repo-relative)" },
  include: { type: "array", items: { type: "string" }, description: "Include globs" },
  exclude: { type: "array", items: { type: "string" }, description: "Exclude globs" },
};

const TOOLS = [
  {
    name: "scan_summary",
    description:
      "Deterministically scan a repository: file count, per-language file histogram, HEAD commit, and whether the walk was capped. Fast first look at any codebase.",
    inputSchema: { type: "object", properties: { ...repoProp, ...scopeProps }, required: ["repo"] },
  },
  {
    name: "graph",
    description:
      "Build the full typed cross-file link-graph (import/call/use/doc-link/mention edges, module grouping, PageRank centrality, Louvain communities, tests-map). Returns graph.json. Large on big repos — prefer scan_summary/symbols/callers for targeted questions.",
    inputSchema: { type: "object", properties: { ...repoProp, ...scopeProps }, required: ["repo"] },
  },
  {
    name: "symbols",
    description:
      "Where is a symbol defined and which files reference it? Returns the definition sites (file, line, kind, exported) and referencing files. Omit `name` for the full symbol index.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, name: { type: "string", description: "Symbol name to look up" } },
      required: ["repo"],
    },
  },
  {
    name: "callers",
    description:
      "Who calls a function? Per-symbol caller index: each defined symbol with the exact (file, line) call sites that bind to it. Omit `name` for the full index.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, name: { type: "string", description: "Symbol name to look up" } },
      required: ["repo"],
    },
  },
  {
    name: "workspaces",
    description:
      "Detect monorepo packages (npm/pnpm/yarn/lerna/nx/cargo/go.work/maven) with the workspace dependency graph, one cycle if present, and a topological build order.",
    inputSchema: { type: "object", properties: { ...repoProp }, required: ["repo"] },
  },
  {
    name: "churn",
    description: "Per-file git commit counts (whole history, or since a ref) — the churn half of hotspot analysis.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, since: { type: "string", description: "Only count commits after this ref" } },
      required: ["repo"],
    },
  },
  {
    name: "symbols_overview",
    description:
      "All symbols declared in ONE file (name, kind, line span, exported, parent), in declaration order — the fastest way to understand a file without reading it.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, file: { type: "string", description: "Repo-relative file path" } },
      required: ["repo", "file"],
    },
  },
  {
    name: "find_symbol",
    description:
      "Find symbol declarations by name or name path ('Class/method' matches a method inside Class). Options: substring matching, includeBody to return the declaration's source. Exact-name matches rank first.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        namePath: { type: "string", description: "Symbol name or Parent/child path" },
        substring: { type: "boolean" },
        includeBody: { type: "boolean" },
      },
      required: ["repo", "namePath"],
    },
  },
  {
    name: "find_references",
    description:
      "Who references a symbol? Three labeled tiers: defs (declarations), callSites (line-precise, import-corroborated call bindings), referencingFiles (file-level identifier/doc mentions — may include homonyms). Confidence decreases across tiers; the labels let you decide what to trust.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, name: { type: "string", description: "Symbol name" } },
      required: ["repo", "name"],
    },
  },
  {
    name: "repo_map",
    description:
      "Token-budgeted map of the repository: the highest-PageRank files with their key exported signatures, deterministically rendered to fit `budgetTokens` (default 1024). The densest single read to understand an unfamiliar codebase.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, budgetTokens: { type: "number", description: "Approximate token budget (default 1024)" } },
      required: ["repo"],
    },
  },
  {
    name: "hotspots",
    description:
      "Where does work concentrate? Files ranked by git churn × size (commits × log2 lines). High-scoring files are where changes and defects cluster.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, since: { type: "string", description: "Only count commits after this ref" } },
      required: ["repo"],
    },
  },
  {
    name: "coupling",
    description:
      "Change coupling: pairs of files that repeatedly change in the same commits — hidden dependencies no import shows. strength 1.0 = every change to one touched the other.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, since: { type: "string", description: "Only mine commits after this ref" } },
      required: ["repo"],
    },
  },
  {
    name: "replace_symbol_body",
    description:
      "WRITE: replace a symbol's whole declaration with `body` (verbatim, supply full indentation). The symbol is resolved by name path ('Class/method'); ambiguity errors list the candidates — qualify with `file`. Line spans come from the AST index.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        namePath: { type: "string" },
        body: { type: "string" },
        file: { type: "string", description: "Disambiguate: repo-relative file containing the symbol" },
      },
      required: ["repo", "namePath", "body"],
    },
  },
  {
    name: "insert_after_symbol",
    description:
      "WRITE: insert `body` after a symbol's declaration (blank-line separation preserved for definition-like kinds). Resolved like replace_symbol_body.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, namePath: { type: "string" }, body: { type: "string" }, file: { type: "string" } },
      required: ["repo", "namePath", "body"],
    },
  },
  {
    name: "insert_before_symbol",
    description:
      "WRITE: insert `body` before a symbol's declaration (blank-line separation preserved). Resolved like replace_symbol_body.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, namePath: { type: "string" }, body: { type: "string" }, file: { type: "string" } },
      required: ["repo", "namePath", "body"],
    },
  },
  {
    name: "write_memory",
    description:
      "Persist a named markdown note under <repo>/.codeindex/memories/ (names may use topic/name form). Write small, focused notes: project map, build commands, conventions.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, name: { type: "string" }, content: { type: "string" } },
      required: ["repo", "name", "content"],
    },
  },
  {
    name: "read_memory",
    description: "Read one persisted memory by name.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, name: { type: "string" } },
      required: ["repo", "name"],
    },
  },
  {
    name: "list_memories",
    description: "List persisted memory names — load this first, then read individual memories on relevance.",
    inputSchema: { type: "object", properties: { ...repoProp }, required: ["repo"] },
  },
  {
    name: "delete_memory",
    description: "Delete one persisted memory by name.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, name: { type: "string" } },
      required: ["repo", "name"],
    },
  },
  {
    name: "dead_code",
    description:
      "Dead-code candidates in two labeled tiers: 'unreferenced' (no call site binds AND nothing references the name) and 'uncalled' (referenced somewhere — re-export, type position — but never called). Exported symbols only; test files and entrypoint-looking files excluded as roots.",
    inputSchema: { type: "object", properties: { ...repoProp, ...scopeProps }, required: ["repo"] },
  },
  {
    name: "complexity",
    description:
      "Cyclomatic-complexity estimates (branch-token counting over AST line spans), most-complex first. Pass `file` for one file's symbols, omit for the repo-wide top. Combine with hotspots: the `risk` field of this tool's sibling ranks complexity × churn.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, file: { type: "string" }, risk: { type: "boolean", description: "Return complexity × git-churn risk ranking instead" } },
      required: ["repo"],
    },
  },
  {
    name: "mermaid",
    description:
      "Mermaid diagram of the module graph (renders inline in Claude/GitHub — no graph database). Optionally scoped to one module's neighborhood.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, module: { type: "string", description: "Module slug to focus on" } },
      required: ["repo"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents (ripgrep when available, deterministic JS fallback otherwise). Returns sorted (file, line, text) hits.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        pattern: { type: "string", description: "Regular expression to search for" },
        globs: { type: "array", items: { type: "string" }, description: "Restrict to matching paths" },
        ignoreCase: { type: "boolean" },
        maxHits: { type: "number" },
      },
      required: ["repo", "pattern"],
    },
  },
  {
    name: "search",
    description:
      'Natural-language-ish lexical search: BM25 ranking (k1=1.2, b=0.75) over symbol names (camelCase/snake_case subtokens), file path segments, markdown headings and summary lines. NOT embeddings by default — deterministic, diacritic-folded, zero API keys. Answers "where is auth handled?"-style queries with ranked files, matched terms and top symbols. Query terms with zero document frequency get a deterministic trigram-fuzzy fallback (typo-tolerant) unless `fuzzy: false`. Set `semantic: true` to RRF-fuse an embedding tier (HTTP endpoint, else a local static model) with lexical — the response then wraps the ranked list as `{ results, tier, degradedReason? }`, `tier` being "endpoint"/"static" when fusion happened or "lexical" (with `degradedReason`) when it did not (see embed_status). Without `semantic`, the response is the bare ranked array, unchanged.',
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...scopeProps,
        query: { type: "string", description: "Natural-language or identifier query" },
        limit: { type: "number", description: "Max results (default 20)" },
        fuzzy: {
          type: "boolean",
          description:
            "Trigram fuzzy fallback for query terms with zero document frequency (default true)",
        },
        semantic: {
          type: "boolean",
          description:
            'RRF-fuse an embedding tier with lexical (default false). Precedence: the HTTP endpoint (CODEINDEX_EMBED_ENDPOINT) if set, else a local static model. The response reports the effective tier as a top-level `tier` field ("endpoint"/"static" on success, "lexical" plus `degradedReason` when neither is available/reachable) instead of degrading silently — see embed_status.',
        },
      },
      required: ["repo", "query"],
    },
  },
  {
    name: "embed_status",
    description:
      "Report the embedding tier: the effective mode (none/static/endpoint; endpoint > static model), the resolved model (opt-in, never shipped in the package) with its modelId/dim, EMBED_VERSION, and the configured HTTP endpoint with its reachability. Use to check whether `search` with semantic:true will fuse embeddings or degrade to lexical.",
    inputSchema: { type: "object", properties: { ...repoProp }, required: ["repo"] },
  },
  {
    name: "check_rules",
    description:
      'Validate dependency-cruiser-style architecture rules against the link-graph. Rules (inline JSON array): forbidden edges {name, from, to, kind?, severity?, comment?} with glob paths, plus builtins {name, builtin: "cycles"|"orphans"} (module-level import cycles; edge-less code files). Returns deterministic violations with severity error|warn — a CI gate.',
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...scopeProps,
        rules: { type: "array", description: "Rules array (inline JSON — see description)" },
      },
      required: ["repo", "rules"],
    },
  },
] as const;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") && v.length ? (v as string[]) : undefined;
}
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- embedding index memoization --------------------------------------------
// The MCP server process is long-lived, but every `search` call used to redo
// the FULL corpus embedding build — N `buildEndpointIndex` HTTP round-trips,
// or a full `buildEmbeddingIndex` re-encode pass — even when nothing in the
// repo changed between requests. Memoize the last build behind a fingerprint
// of the scan contents plus the tier's identity, so an unchanged repo reuses
// the cached index and any file add/edit/remove (or a switch of endpoint/model)
// still rebuilds. RepoScan carries no fingerprint of its own (checked
// scan.ts/types.ts) — every FileRecord already carries a content hash, so
// hashing the (rel, hash) pairs is the staleness oracle scan.ts itself uses.
export function scanFingerprint(scan: RepoScan): string {
  return sha1(scan.files.map((f) => `${f.rel}:${f.hash}`).join("\n"));
}

export interface EmbeddingIndexCacheKey {
  mode: "endpoint" | "static";
  // Distinguishes cache entries across configs sharing the same scan: the
  // endpoint URL, or the model dir + modelId for the static tier.
  identity: string;
  scan: RepoScan;
}

// A SINGLE entry — never an unbounded map — holding the most recent build.
let embeddingIndexCache: { key: string; index: EmbeddingIndex } | undefined;

// Reuse the cached index when (mode, identity, scanFingerprint) matches the
// last build; otherwise call `build` and cache its result. A failed build is
// NEVER cached (matches today's per-call error behavior: the next request
// retries from scratch, and a still-valid previous entry — under a different
// key — is left untouched).
export async function memoizedEmbeddingIndex(
  key: EmbeddingIndexCacheKey,
  build: () => Promise<EmbeddingIndex> | EmbeddingIndex,
): Promise<EmbeddingIndex> {
  const cacheKey = `${key.mode}:${key.identity}:${scanFingerprint(key.scan)}`;
  if (embeddingIndexCache && embeddingIndexCache.key === cacheKey) return embeddingIndexCache.index;
  const index = await build();
  embeddingIndexCache = { key: cacheKey, index };
  return index;
}

// A SINGLE entry — never an unbounded map — holding the most recent parse.
let embedModelCache: { key: string; model: StaticEmbedModel } | undefined;

// model.json is 10-30 MB with the real asset; reading + JSON.parsing it on
// EVERY request dominates static-tier latency, so the parsed model is memoized
// across requests. One statSync per request keys the cache on
// (dir, mtimeMs, size) so an in-place re-pull invalidates on the next call.
// Same discipline as memoizedEmbeddingIndex: a failed load is NEVER cached —
// the throw propagates and the cache is left as it was, so the next request
// retries from scratch. A missing model.json returns undefined (the
// not-present case, exactly like loadEmbedModel).
export function memoizedEmbedModel(modelDir: string): StaticEmbedModel | undefined {
  let stat;
  try {
    stat = statSync(join(modelDir, "model.json"));
  } catch {
    return undefined;
  }
  const key = `${modelDir}:${stat.mtimeMs}:${stat.size}`;
  if (embedModelCache && embedModelCache.key === key) return embedModelCache.model;
  const model = loadEmbedModel(modelDir);
  if (model) embedModelCache = { key, model };
  return model;
}

// --- session-level scan + artifacts memoization ------------------------------
// Same single-entry discipline as the embedding caches above: the MCP server
// process is long-lived, but every tool call used to redo a FULL scanRepo walk
// + read + hash + extraction pass (and, for graph-shaped tools, the whole
// pipeline) even when nothing in the repo changed between requests. Cache the
// last (repo, scan-opts) scan and feed its records back to scanRepo as `cache`
// on the next call — scan.ts's EXISTING stat-fastpath + exact-hash machinery
// is the freshness oracle, so a cache hit costs one walk + per-file stats, not
// reads. When the oracle proves the content unchanged the SAME RepoScan object
// is returned, which keeps the per-scan WeakMap of derived structures
// (src/derived.ts) warm across requests. Artifacts are memoized on scan object
// identity. Rendered strings are NEVER memoized — a big repo's graph.json runs
// tens of MB, so renders stay per-call while the expensive structures behind
// them are reused.
//
// Determinism: reused records come from scan.ts's own reuse paths (stat
// fastpath / exact content-hash match), which produce records value-identical
// to a from-scratch scan — artifacts stay byte-identical; only repeated work
// disappears.

// The scan options a session entry is keyed on. `cache`/`precomputedWalk` are
// excluded from the contract: the session cache OWNS the cache it feeds back,
// and a caller-supplied stale walk would desynchronize the freshness oracle.
export type SessionScanOptions = Omit<ScanOptions, "cache" | "precomputedWalk">;

type SessionCacheMap = Map<string, { hash: string; record: FileRecord; size?: number; mtimeMs?: number }>;

// A SINGLE entry — never an unbounded map — holding the most recent scan.
let sessionCache:
  | { key: string; scan: RepoScan; cacheMap: SessionCacheMap; arts?: IndexArtifacts }
  | undefined;

// Fixed property order (and JSON.stringify dropping undefined) keeps the key
// deterministic regardless of how the caller assembled the options object.
function sessionKey(repo: string, opts: SessionScanOptions): string {
  return (
    repo +
    "\0" +
    JSON.stringify({
      scope: opts.scope,
      include: opts.include,
      exclude: opts.exclude,
      gitignore: opts.gitignore,
      ignoreDirs: opts.ignoreDirs,
      maxBytes: opts.maxBytes,
      maxFiles: opts.maxFiles,
      maxCallsPerFile: opts.maxCallsPerFile,
      out: opts.out,
      fullHash: opts.fullHash,
    })
  );
}

// A scan re-expressed as the `ScanOptions.cache` shape (the exact map the CLI
// persists as cache.json): rel → (hash, record, size, mtimeMs), so the next
// scanRepo can take the stat fastpath / hash-match reuse paths against it.
// Exported for tests.
export function toCacheMap(scan: RepoScan): SessionCacheMap {
  const m: SessionCacheMap = new Map();
  for (const f of scan.files) m.set(f.rel, { hash: f.hash, record: f, size: f.size, mtimeMs: scan.mtimes.get(f.rel) });
  return m;
}

// The memoizing replacement for scanRepo inside callTool. Exported for tests.
export function getScan(repo: string, opts: SessionScanOptions = {}): RepoScan {
  const key = sessionKey(repo, opts);
  if (sessionCache && sessionCache.key === key) {
    const fresh = scanRepo(repo, { ...opts, cache: sessionCache.cacheMap });
    if (fresh.contentUnchanged) {
      // Content proven identical → return the SAME object (object identity is
      // what keeps derived.ts's WeakMap and the memoized artifacts warm). A
      // stat-only drift (e.g. a bare touch) still refreshes the cache map so
      // the next call's stat fastpath keys on the new (size, mtimeMs).
      if (fresh.cacheDirty) sessionCache.cacheMap = toCacheMap(fresh);
      return sessionCache.scan;
    }
    sessionCache = { key, scan: fresh, cacheMap: toCacheMap(fresh) };
    return fresh;
  }
  const scan = scanRepo(repo, opts);
  sessionCache = { key, scan, cacheMap: toCacheMap(scan) };
  return scan;
}

// Lazy pipeline memoized on scan OBJECT IDENTITY: graph-shaped tools reuse the
// artifacts exactly as long as getScan keeps returning the same scan object.
// Exported for tests.
export function getArtifacts(repo: string, opts: SessionScanOptions = {}): IndexArtifacts {
  const scan = getScan(repo, opts);
  if (sessionCache && sessionCache.scan === scan) {
    return (sessionCache.arts ??= buildArtifactsFromScan(scan, opts));
  }
  // Defensive fallback (getScan always leaves sessionCache holding `scan`).
  return buildArtifactsFromScan(scan, opts);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const repo = str(args.repo);
  if (!repo) throw new Error("`repo` is required (absolute path to the repository root)");
  const scanOpts = { scope: str(args.scope), include: strArray(args.include), exclude: strArray(args.exclude) };

  if (name === "scan_summary") {
    const scan = getScan(repo, scanOpts);
    return JSON.stringify(
      { engineVersion: ENGINE_VERSION, commit: scan.commit, fileCount: scan.files.length, languages: scan.languages, capped: scan.capped },
      null,
      2,
    );
  }
  if (name === "graph") {
    return renderGraphJson(getArtifacts(repo, scanOpts).graph);
  }
  if (name === "symbols") {
    const { symbols } = getArtifacts(repo, scanOpts);
    const lookup = str(args.name);
    if (lookup) {
      return JSON.stringify({ name: lookup, defs: symbols.defs[lookup] ?? [], refs: symbols.refs[lookup] ?? [] }, null, 2);
    }
    return JSON.stringify(symbols, null, 2);
  }
  if (name === "callers") {
    const index = buildCallerIndex(getScan(repo, scanOpts));
    const lookup = str(args.name);
    if (lookup) {
      const entry = index.get(lookup);
      return JSON.stringify(entry ?? { error: `no tracked callers for "${lookup}"` }, null, 2);
    }
    const obj: Record<string, unknown> = {};
    for (const [k, v] of index) obj[k] = v;
    return JSON.stringify(obj, null, 2);
  }
  if (name === "workspaces") {
    const info = detectWorkspaces(repo);
    return JSON.stringify({ packages: info.packages, cycle: info.cycle ?? null, topoOrder: info.topoOrder }, null, 2);
  }
  if (name === "churn") {
    const { churn, ok } = gitChurn(repo, { since: str(args.since) });
    const sorted: Record<string, number> = {};
    for (const k of [...churn.keys()].sort()) sorted[k] = churn.get(k)!;
    return JSON.stringify({ ok, churn: sorted }, null, 2);
  }
  if (name === "symbols_overview") {
    const file = str(args.file);
    if (!file) throw new Error("`file` is required");
    return JSON.stringify(symbolsOverview(getScan(repo, scanOpts), file), null, 2);
  }
  if (name === "find_symbol") {
    const namePath = str(args.namePath);
    if (!namePath) throw new Error("`namePath` is required");
    const matches = findSymbol(getScan(repo, scanOpts), namePath, {
      substring: args.substring === true,
      includeBody: args.includeBody === true,
    });
    return JSON.stringify(matches, null, 2);
  }
  if (name === "find_references") {
    const symName = str(args.name);
    if (!symName) throw new Error("`name` is required");
    return JSON.stringify(findReferences(getScan(repo, scanOpts), symName), null, 2);
  }
  if (name === "replace_symbol_body" || name === "insert_after_symbol" || name === "insert_before_symbol") {
    const namePath = str(args.namePath);
    const body = typeof args.body === "string" ? args.body : undefined;
    if (!namePath || body === undefined) throw new Error("`namePath` and `body` are required");
    const scan = getScan(repo, scanOpts);
    const fn = name === "replace_symbol_body" ? replaceSymbolBody : name === "insert_after_symbol" ? insertAfterSymbol : insertBeforeSymbol;
    const result = fn(scan, namePath, body, str(args.file));
    // A write WE just performed must not be trusted to the stat oracle: an
    // edit landing in the same mtime tick with the same byte count would pass
    // the (size, mtimeMs) fastpath and serve a stale scan. Drop the whole
    // session entry unconditionally — the next call rescans from scratch.
    // (write_memory needs no invalidation: .codeindex/ is excluded from the
    // walk, so memories never enter a scan.)
    sessionCache = undefined;
    return JSON.stringify(result, null, 2);
  }
  if (name === "write_memory") {
    const memName = str(args.name);
    const content = typeof args.content === "string" ? args.content : undefined;
    if (!memName || content === undefined) throw new Error("`name` and `content` are required");
    return JSON.stringify({ written: writeMemory(repo, memName, content) }, null, 2);
  }
  if (name === "read_memory") {
    const memName = str(args.name);
    if (!memName) throw new Error("`name` is required");
    const content = readMemory(repo, memName);
    if (content === undefined) throw new Error(`no memory named "${memName}" — see list_memories`);
    return content;
  }
  if (name === "list_memories") {
    return JSON.stringify(listMemories(repo), null, 2);
  }
  if (name === "delete_memory") {
    const memName = str(args.name);
    if (!memName) throw new Error("`name` is required");
    return JSON.stringify({ deleted: deleteMemory(repo, memName) }, null, 2);
  }
  if (name === "dead_code") {
    return JSON.stringify(findDeadCode(getScan(repo, scanOpts)), null, 2);
  }
  if (name === "complexity") {
    const scan = getScan(repo, scanOpts);
    if (args.risk === true) {
      const { churn, ok } = gitChurn(repo);
      return JSON.stringify({ churnOk: ok, risks: riskHotspots(scan, churn) }, null, 2);
    }
    return JSON.stringify(symbolComplexity(scan, str(args.file)), null, 2);
  }
  if (name === "mermaid") {
    const { graph } = getArtifacts(repo, scanOpts);
    return renderMermaid(graph, { module: str(args.module) });
  }
  if (name === "repo_map") {
    const { scan, graph } = getArtifacts(repo, scanOpts);
    return renderRepoMap(scan, graph, { budgetTokens: typeof args.budgetTokens === "number" ? args.budgetTokens : undefined });
  }
  if (name === "hotspots") {
    const scan = getScan(repo, scanOpts);
    const { churn, ok } = gitChurn(repo, { since: str(args.since) });
    return JSON.stringify({ churnOk: ok, hotspots: rankHotspots(scan, churn) }, null, 2);
  }
  if (name === "coupling") {
    const { ok, couplings } = changeCoupling(repo, { since: str(args.since) });
    return JSON.stringify({ ok, couplings }, null, 2);
  }
  if (name === "grep") {
    const pattern = str(args.pattern);
    if (!pattern) throw new Error("`pattern` is required");
    const hits = grepRepo(repo, pattern, {
      globs: strArray(args.globs),
      ignoreCase: args.ignoreCase === true,
      maxHits: typeof args.maxHits === "number" ? args.maxHits : undefined,
    });
    return JSON.stringify(hits, null, 2);
  }
  if (name === "search") {
    const query = str(args.query);
    if (!query) throw new Error("`query` is required");
    const scan = getScan(repo, scanOpts);
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const fuzzy = typeof args.fuzzy === "boolean" ? args.fuzzy : undefined;
    if (args.semantic === true) {
      // semantic:true changes the response SHAPE (wraps the ranked list with a
      // `tier`/`degradedReason?`) so a caller can tell "fusion happened" apart
      // from "degraded to lexical" — see the `search` tool description. This
      // branch is the ONLY place that shape appears; plain lexical search below
      // stays the bare array, byte-compat for existing consumers.
      const endpoint = resolveEmbedEndpoint();
      if (endpoint) {
        // Rich tier — endpoint takes PRECEDENCE over a local static model. An
        // unreachable/malformed endpoint degrades to lexical, now with a reason.
        // The corpus index is memoized per (endpoint, scan state) — the query
        // itself is always re-encoded fresh (it differs per call).
        try {
          const index = await memoizedEmbeddingIndex({ mode: "endpoint", identity: endpoint, scan }, () => buildEndpointIndex(scan));
          const queryVec = await encodeQueryViaEndpoint(query);
          const results = searchSemantic(scan, query, index, { queryVec, limit, fuzzy });
          return JSON.stringify({ results, tier: "endpoint" }, null, 2);
        } catch (e) {
          const results = searchIndex(scan, query, { limit, fuzzy });
          return JSON.stringify(
            { results, tier: "lexical", degradedReason: `embedding endpoint failed: ${errMessage(e)}` },
            null,
            2,
          );
        }
      }
      const modelDir = resolveEmbedModelDir(repo);
      const model = modelDir ? memoizedEmbedModel(modelDir) : undefined;
      if (model) {
        const index = await memoizedEmbeddingIndex(
          { mode: "static", identity: `${modelDir}#${model.modelId}`, scan },
          () => buildEmbeddingIndex(scan, model),
        );
        const results = searchSemantic(scan, query, index, { model, limit, fuzzy });
        return JSON.stringify({ results, tier: "static" }, null, 2);
      }
      // Opt-in tier not activated (no endpoint, no model asset) — degrade to
      // lexical with a reason instead of failing silently.
      const results = searchIndex(scan, query, { limit, fuzzy });
      return JSON.stringify(
        { results, tier: "lexical", degradedReason: "no embedding endpoint or static model configured — see embed_status" },
        null,
        2,
      );
    }
    return JSON.stringify(searchIndex(scan, query, { limit, fuzzy }), null, 2);
  }
  if (name === "embed_status") {
    const modelDir = resolveEmbedModelDir(repo);
    const model = modelDir ? memoizedEmbedModel(modelDir) : undefined;
    const endpoint = resolveEmbedEndpoint();
    const mode: "none" | "static" | "endpoint" = endpoint ? "endpoint" : model ? "static" : "none";
    const status: Record<string, unknown> = {
      embedVersion: EMBED_VERSION,
      mode,
      model: model
        ? { present: true, dir: modelDir, modelId: model.modelId, dim: model.dim, vocabSize: model.vocabSize }
        : { present: false },
      endpoint: endpoint ?? null,
    };
    if (endpoint) status.endpointReachable = await probeEndpoint(endpoint);
    return JSON.stringify(status, null, 2);
  }
  if (name === "check_rules") {
    const rules = parseRules(args.rules); // throws a descriptive error on a malformed payload
    const { graph } = getArtifacts(repo, scanOpts);
    return JSON.stringify(checkRules(graph, rules), null, 2);
  }
  throw new Error(`unknown tool: ${name}`);
}

export interface McpServerOptions {
  // Override the serverInfo announced in the initialize response — for
  // downstream consumers embedding this server under their own identity.
  // Omitted fields keep the defaults (name "codeindex", ENGINE_VERSION).
  serverInfo?: { name?: string; version?: string };
}

export async function runMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const serverInfo = {
    name: opts.serverInfo?.name ?? "codeindex",
    version: opts.serverInfo?.version ?? ENGINE_VERSION,
  };
  await ensureGrammars(allGrammarKeys()); // AST tier when the sidecar is present

  const send = (msg: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  };

  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      send({ id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    // JSON-RPC 2.0 batch: answer each member (a batching client would
    // otherwise hang forever on a silently dropped array).
    const requests = Array.isArray(parsed) ? (parsed as RpcRequest[]) : [parsed as RpcRequest];
    for (const req of requests) await handle(req);
  }

  async function handle(req: RpcRequest): Promise<void> {
    if (req.id === undefined || req.id === null) return; // notification — no response

    try {
      if (req.method === "initialize") {
        send({
          id: req.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo,
          },
        });
      } else if (req.method === "ping") {
        send({ id: req.id, result: {} });
      } else if (req.method === "tools/list") {
        send({ id: req.id, result: { tools: TOOLS } });
      } else if (req.method === "tools/call") {
        const params = req.params ?? {};
        const name = str(params.name) ?? "";
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const text = await callTool(name, args);
          send({ id: req.id, result: { content: [{ type: "text", text }] } });
        } catch (e) {
          send({
            id: req.id,
            result: { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true },
          });
        }
      } else {
        send({ id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
      }
    } catch (e) {
      send({ id: req.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    }
  }
}
