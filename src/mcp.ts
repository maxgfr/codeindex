// MCP (Model Context Protocol) server over stdio — hand-rolled JSON-RPC 2.0 so
// the engine stays zero-dependency. Newline-delimited JSON messages, protocol
// 2024-11-05 (compatible with later revisions' initialize handshake). Exposes
// the engine's indexing capabilities as MCP tools; every tool takes a `repo`
// path and returns text content — JSON, except repo_map, mermaid and
// read_memory, which return their own formats.
//
// Register in an MCP client as:  codeindex mcp
// (NOT `node scripts/engine.mjs mcp`: engine.mjs is a side-effect-free library
// with no main-module guard — see src/engine.ts — so that command does nothing.
// The entrypoint is the `codeindex` bin, i.e. scripts/cli.mjs.)
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { ENGINE_VERSION } from "./types.js";
import { renderGraphJson } from "./render/graph-json.js";
import { buildCallerIndex } from "./callers.js";
import { callerIndexFor, hierarchyFor, symbolGraphFor } from "./derived.js";
import { implementationsOf } from "./relations.js";
import { neighborhood, type Direction } from "./symbolgraph.js";
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
import { searchIndex, type RankMode } from "./bm25.js";
import { checkRules, parseRules } from "./rules.js";
import { EMBED_VERSION, resolveEmbedModelDir } from "./embed/model.js";
import { buildEmbeddingIndex } from "./embed/index.js";
import { searchSemantic } from "./embed/search.js";
import { resolveEmbedEndpoint, buildEndpointIndex, encodeQueryViaEndpoint, probeEndpoint } from "./embed/endpoint.js";
import { walk, type WalkResult } from "./walk.js";
import { toolsFor, OUTPUT_SCHEMAS } from "./mcp/tools.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  RICH_TOOLS_SINCE,
  PROTOCOL_VERSIONS,
  capResponse,
  negotiateProtocol,
  resourceLinkFor,
  structuredContentFor,
  validateArgs,
} from "./mcp/protocol.js";
import {
  getArtifacts,
  getScan,
  getScanSummary,
  memoizedEmbeddingIndex,
  memoizedEmbedModel,
  scanFingerprint,
  sessionClear,
  warmGrammarsForWalk,
  type SessionScanOptions,
} from "./mcp/session.js";

// The public surface of this module is unchanged: everything that used to live
// here is re-exported, so `src/engine.ts`, the tests and any consumer importing
// from "./mcp.js" keep working exactly as before.
export { toolsFor, TOOLS, TOOL_META, OUTPUT_SCHEMAS, annotationsFor } from "./mcp/tools.js";
export {
  DEFAULT_MAX_RESPONSE_BYTES,
  PROTOCOL_VERSIONS,
  capResponse,
  negotiateProtocol,
  resourceLinkFor,
  structuredContentFor,
  validateArgs,
} from "./mcp/protocol.js";
export {
  getArtifacts,
  getScan,
  getScanSummary,
  memoizedEmbeddingIndex,
  memoizedEmbedModel,
  scanFingerprint,
  toCacheMap,
  warmGrammarsForRepo,
  warmGrammarsForWalk,
} from "./mcp/session.js";
export type { EmbeddingIndexCacheKey, SessionScanOptions } from "./mcp/session.js";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") && v.length ? (v as string[]) : undefined;
}
// A positive numeric argument. Also accepts the numeric STRING a JSON-Schema-less
// client may send: `"50"` used to fall through to the default in silence, which
// reads to the caller as the option being ignored.
function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Tools that never scan the file tree (git/grep/memory/embed-status only) — they
// must not trigger a grammar warm. Every other tool is scan-needing and warms
// the repo's grammars first; defaulting to "warm" keeps a newly added scan tool
// correct without having to be listed here.
const SCANLESS_TOOLS = new Set([
  "workspaces", "churn", "coupling", "grep",
  "write_memory", "read_memory", "list_memories", "delete_memory",
  "embed_status",
  // scan_summary counts and classifies by path only — it never parses, so the
  // grammar warm (a whole extra walk) would be pure overhead. When a scan is
  // already cached getScanSummary reuses it, warm grammars included.
  "scan_summary",
]);

async function callTool(name: string, args: Record<string, unknown>, defaultRepo?: string): Promise<string> {
  // An explicit per-call `repo` always wins; `defaultRepo` is the server-level
  // pin (`codeindex mcp --repo <dir>`) that lets a host bind one server process
  // to one workspace, so agents need not know — or restate — the absolute path.
  const repo = str(args.repo) ?? defaultRepo;
  if (!repo) throw new Error("`repo` is required (absolute path to the repository root)");
  const scanOpts = { scope: str(args.scope), include: strArray(args.include), exclude: strArray(args.exclude) };
  // `search`'s optional structural prior; anything else falls back to the default.
  const rankArg = str(args.rank);
  const rankOpt: { rank?: RankMode } = rankArg === "graph" || rankArg === "lexical" ? { rank: rankArg } : {};
  // Scan-needing tools warm the present-language grammars (re-derived per call)
  // before any scan so extraction takes the AST tier; scan-less tools skip it.
  // ONE walk feeds both the warm and the scan below — see warmGrammarsForWalk.
  let walked: WalkResult | undefined;
  if (!SCANLESS_TOOLS.has(name)) {
    walked = walk(repo, {});
    await warmGrammarsForWalk(walked);
  }

  if (name === "scan_summary") {
    const s = getScanSummary(repo, scanOpts, walked);
    return JSON.stringify(
      { engineVersion: ENGINE_VERSION, commit: s.commit, fileCount: s.fileCount, languages: s.languages, capped: s.capped },
      null,
      2,
    );
  }
  if (name === "graph") {
    return renderGraphJson(getArtifacts(repo, scanOpts, walked).graph);
  }
  if (name === "symbols") {
    const { symbols } = getArtifacts(repo, scanOpts, walked);
    const lookup = str(args.name);
    if (lookup) {
      return JSON.stringify({ name: lookup, defs: symbols.defs[lookup] ?? [], refs: symbols.refs[lookup] ?? [] }, null, 2);
    }
    return JSON.stringify(symbols, null, 2);
  }
  if (name === "callers") {
    // callerIndexFor, not buildCallerIndex: the public builder is unmemoized, so
    // this rebuilt the whole index on EVERY request (318ms per call on a 20k-file
    // repo in the project's own benchmark). The memoized one is keyed on scan
    // object identity, which the session cache preserves across calls.
    // Recall mode is option-dependent, so it cannot use the memoized index.
    const scan = getScan(repo, scanOpts, walked);
    const index = args.recall === true ? buildCallerIndex(scan, undefined, { recall: true }) : callerIndexFor(scan);
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
    return JSON.stringify(symbolsOverview(getScan(repo, scanOpts, walked), file), null, 2);
  }
  if (name === "find_symbol") {
    const namePath = str(args.namePath);
    if (!namePath) throw new Error("`namePath` is required");
    const matches = findSymbol(getScan(repo, scanOpts, walked), namePath, {
      substring: args.substring === true,
      includeBody: args.includeBody === true,
      maxResults: num(args.maxResults),
    });
    return JSON.stringify(matches, null, 2);
  }
  if (name === "find_references") {
    const symName = str(args.name);
    if (!symName) throw new Error("`name` is required");
    return JSON.stringify(findReferences(getScan(repo, scanOpts, walked), symName), null, 2);
  }
  if (name === "replace_symbol_body" || name === "insert_after_symbol" || name === "insert_before_symbol") {
    const namePath = str(args.namePath);
    const body = typeof args.body === "string" ? args.body : undefined;
    if (!namePath || body === undefined) throw new Error("`namePath` and `body` are required");
    const scan = getScan(repo, scanOpts, walked);
    const fn = name === "replace_symbol_body" ? replaceSymbolBody : name === "insert_after_symbol" ? insertAfterSymbol : insertBeforeSymbol;
    const result = fn(scan, namePath, body, str(args.file));
    // A write WE just performed must not be trusted to the stat oracle: an
    // edit landing in the same mtime tick with the same byte count would pass
    // the (size, mtimeMs) fastpath and serve a stale scan. Drop the whole
    // session entry unconditionally — the next call rescans from scratch.
    // (write_memory needs no invalidation: .codeindex/ is excluded from the
    // walk, so memories never enter a scan.)
    sessionClear();
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
    const all = findDeadCode(getScan(repo, scanOpts, walked));
    const limit = num(args.limit);
    // Additive: without `limit` the payload is exactly what it always was.
    if (limit === undefined || all.length <= limit) return JSON.stringify(all, null, 2);
    return JSON.stringify({ total: all.length, shown: limit, truncated: true, candidates: all.slice(0, limit) }, null, 2);
  }
  if (name === "complexity") {
    const scan = getScan(repo, scanOpts, walked);
    if (args.risk === true) {
      // `since` was accepted by the CLI's `risk` but silently dropped here.
      const { churn, ok } = gitChurn(repo, { since: str(args.since) });
      return JSON.stringify({ churnOk: ok, risks: riskHotspots(scan, churn, num(args.top)) }, null, 2);
    }
    return JSON.stringify(symbolComplexity(scan, str(args.file), num(args.top)), null, 2);
  }
  if (name === "mermaid") {
    const { graph } = getArtifacts(repo, scanOpts, walked);
    return renderMermaid(graph, { module: str(args.module), maxEdges: num(args.maxEdges) });
  }
  if (name === "repo_map") {
    const { scan, graph } = getArtifacts(repo, scanOpts, walked);
    return renderRepoMap(scan, graph, { budgetTokens: typeof args.budgetTokens === "number" ? args.budgetTokens : undefined });
  }
  if (name === "hotspots") {
    const scan = getScan(repo, scanOpts, walked);
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
    // `scope` was CLI-only: the a205c34 fix folded it into the CLI's glob list
    // but this handler ignored scanOpts entirely.
    const scope = str(args.scope);
    const globs = strArray(args.globs);
    const hits = grepRepo(repo, pattern, {
      globs: scope ? [...(globs ?? []), `${scope.replace(/\/+$/, "")}/**`] : globs,
      ignoreCase: args.ignoreCase === true,
      maxHits: typeof args.maxHits === "number" ? args.maxHits : undefined,
    });
    return JSON.stringify(hits, null, 2);
  }
  if (name === "search") {
    const query = str(args.query);
    if (!query) throw new Error("`query` is required");
    const scan = getScan(repo, scanOpts, walked);
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
          const results = searchIndex(scan, query, { limit, fuzzy, ...rankOpt });
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
      const results = searchIndex(scan, query, { limit, fuzzy, ...rankOpt });
      return JSON.stringify(
        { results, tier: "lexical", degradedReason: "no embedding endpoint or static model configured — see embed_status" },
        null,
        2,
      );
    }
    return JSON.stringify(searchIndex(scan, query, { limit, fuzzy, ...rankOpt }), null, 2);
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
  if (name === "type_hierarchy") {
    const hierarchy = hierarchyFor(getScan(repo, scanOpts, walked));
    const wanted = str(args.name);
    if (!wanted) {
      const obj: Record<string, unknown> = {};
      for (const [key, entry] of hierarchy) obj[key] = entry;
      return JSON.stringify(obj, null, 2);
    }
    const entry = hierarchy.get(wanted);
    if (!entry) return JSON.stringify({ error: `no type named ${wanted}` }, null, 2);
    return JSON.stringify(entry, null, 2);
  }
  if (name === "implementations") {
    const wanted = str(args.name);
    if (!wanted) throw new Error("`name` is required");
    const hierarchy = hierarchyFor(getScan(repo, scanOpts, walked));
    if (!hierarchy.has(wanted)) return JSON.stringify({ error: `no type named ${wanted}` }, null, 2);
    return JSON.stringify({ name: wanted, implementations: implementationsOf(hierarchy, wanted) }, null, 2);
  }
  if (name === "call_graph") {
    const symbol = str(args.symbol);
    if (!symbol) throw new Error("`symbol` is required");
    const direction = str(args.direction);
    const dir: Direction = direction === "out" || direction === "in" ? direction : "both";
    const result = neighborhood(symbolGraphFor(getScan(repo, scanOpts, walked)), symbol, {
      ...(typeof args.depth === "number" ? { depth: args.depth } : {}),
      direction: dir,
    });
    if (!result.root.length) return JSON.stringify({ error: `no symbol named ${symbol}` }, null, 2);
    return JSON.stringify(result, null, 2);
  }
  if (name === "check_rules") {
    // Inline `rules` stays the primary form; `configPath` is the CLI's --config,
    // which had no MCP equivalent, so a repo with a committed rules file had to
    // have it re-pasted into every call.
    const configPath = str(args.configPath);
    let payload: unknown = args.rules;
    if (payload === undefined && configPath) {
      const abs = isAbsolute(configPath) ? configPath : join(repo, configPath);
      try {
        payload = JSON.parse(readFileSync(abs, "utf8"));
      } catch (e) {
        throw new Error(`cannot read rules from ${abs}: ${errMessage(e)}`);
      }
    }
    if (payload === undefined) throw new Error("`rules` (or `configPath`) is required");
    const rules = parseRules(payload); // throws a descriptive error on a malformed payload
    const { graph } = getArtifacts(repo, scanOpts, walked);
    return JSON.stringify(checkRules(graph, rules), null, 2);
  }
  throw new Error(`unknown tool: ${name}`);
}

export interface McpServerOptions {
  // Override the serverInfo announced in the initialize response — for
  // downstream consumers embedding this server under their own identity.
  // Omitted fields keep the defaults (name "codeindex", ENGINE_VERSION).
  serverInfo?: { name?: string; version?: string };
  // Bind the server to ONE repository, so `repo` becomes optional on every
  // tool (an explicit per-call `repo` still wins). This is what lets a host
  // spawn one server per workspace — `codeindex mcp --repo <dir>` — instead of
  // requiring the agent to thread an absolute path through every single call.
  defaultRepo?: string;
  // Cap on a single tool response, in bytes (default DEFAULT_MAX_RESPONSE_BYTES).
  // Responses under it are untouched; see capResponse for what happens above it.
  maxResponseBytes?: number;
}

export async function runMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const serverInfo = {
    name: opts.serverInfo?.name ?? "codeindex",
    version: opts.serverInfo?.version ?? ENGINE_VERSION,
  };
  // The negotiated protocol version, settled by `initialize` and fixed for the
  // session. Until a client says otherwise we assume the oldest revision, so a
  // client that skips the handshake sees exactly the pre-negotiation server.
  let protocolVersion: string = PROTOCOL_VERSIONS[0];
  // Rebuilt when negotiation lands: the pin cannot change mid-session, but the
  // fields we are allowed to advertise depend on the version.
  let tools = toolsFor(opts.defaultRepo, protocolVersion);
  // No startup warm: each scan-needing tool warms the present-language grammars
  // for its repo before it runs (warmGrammarsForRepo re-derives them per call),
  // so a session that never scans — or only touches one language — loads no
  // unused wasm, and a language first seen mid-session still gets warmed.

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
        protocolVersion = negotiateProtocol(req.params?.protocolVersion);
        tools = toolsFor(opts.defaultRepo, protocolVersion);
        send({
          id: req.id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo,
          },
        });
      } else if (req.method === "ping") {
        send({ id: req.id, result: {} });
      } else if (req.method === "tools/list") {
        send({ id: req.id, result: { tools } });
      } else if (req.method === "tools/call") {
        const params = req.params ?? {};
        const name = str(params.name) ?? "";
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const decl = (tools as { name: string; inputSchema: { properties?: Record<string, unknown> } }[]).find(
            (t) => t.name === name,
          );
          const invalid = decl ? validateArgs(decl.inputSchema, args) : undefined;
          if (invalid) throw new Error(invalid);
          const raw = await callTool(name, args, opts.defaultRepo);
          const repo = str(args.repo) ?? opts.defaultRepo ?? "";
          const text = capResponse(raw, name, repo, opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
          // A capped whole-repo response points at an artifact already on disk.
          // From 2025-06-18 the protocol has a content type that says exactly
          // that, so the client can fetch the bytes instead of re-asking.
          //
          // Gated on `text !== raw` — i.e. capResponse actually replaced the
          // payload. Otherwise a normal 900 KB graph would be JSON.parsed on
          // every single call just to discover it was not truncated.
          const capped = text !== raw;
          const link = capped && protocolVersion >= RICH_TOOLS_SINCE ? resourceLinkFor(text, name) : undefined;
          // Typed, validatable result alongside the text block — for the tools
          // that declare an outputSchema, and never when the guard replaced the
          // payload (see structuredContentFor).
          const structured =
            protocolVersion >= RICH_TOOLS_SINCE
              ? structuredContentFor(text, capped, OUTPUT_SCHEMAS[name] !== undefined)
              : undefined;
          send({
            id: req.id,
            result: {
              content: link ? [{ type: "text", text }, link] : [{ type: "text", text }],
              ...(structured ? { structuredContent: structured } : {}),
            },
          });
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
