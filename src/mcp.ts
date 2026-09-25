// MCP (Model Context Protocol) server over stdio — hand-rolled JSON-RPC 2.0 so
// the engine stays zero-dependency. Newline-delimited JSON messages; the
// protocol revision is negotiated at initialize (see mcp/protocol.ts). Exposes
// the engine's indexing capabilities as MCP tools; every tool takes a `repo`
// path and returns text content — JSON, except repo_map, mermaid and
// read_memory, which return their own formats.
//
// Register in an MCP client as:  codeindex mcp
// (NOT `node scripts/engine.mjs mcp`: engine.mjs is a side-effect-free library
// with no main-module guard — see src/engine.ts — so that command does nothing.
// The entrypoint is the `codeindex` bin, i.e. scripts/cli.mjs.)
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { ENGINE_VERSION } from "./types.js";
import { renderGraphJson } from "./render/graph-json.js";
import { buildCallerIndex, lookupCallerEntry, rawCallerSitesFor, type CallerEntry } from "./callers.js";
import { callerIndexFor, fileByRelFor, hierarchyFor, symbolGraphFor } from "./derived.js";
import { byStr } from "./sort.js";
import type { RepoScan } from "./scan.js";
import { implementationsOf, typeEntry } from "./relations.js";
import { callPath, neighborhood, type Direction } from "./symbolgraph.js";
import { checkWorkspaceDeps, detectWorkspaces, workspaceReport } from "./workspaces.js";
import { gitChurn, historyStatus } from "./git.js";
import { grepRepoEx } from "./grep.js";
import { changeCoupling, rankHotspots } from "./coupling.js";
import { renderRepoMap } from "./repomap.js";
import { capDeadCode, findDeadCode } from "./deadcode.js";
import { findLiteralDuplications } from "./literals.js";
import { symbolComplexity, riskHotspots } from "./complexity.js";
import { renderMermaid } from "./viz.js";
import { resolutionReport } from "./resolution.js";
import { symbolsOverview, findSymbol, findReferences, explainNoCallers, rawCallersOf, resolveSymbolRef, symbolAt, withCallerIds } from "./query.js";
import { fileArgReadings, resolveFileArg } from "./patharg.js";
import { EDGE_KINDS, dependencyPath, impactOf, neighborsOf } from "./traverse.js";
import { formatSymbolRef } from "./symref.js";
import { lspStatus, referencesWithLsp, callersWithLsp, LspSessionPool } from "./lsp/index.js";
import { conciseCaller, conciseDelta, conciseReferences, conciseSymbolIndex, symbolLocation } from "./mcp/concise.js";
import { onboardBrief } from "./onboard.js";
import { indexStatus } from "./status.js";
import { replaceSymbolBody, insertAfterSymbol, insertBeforeSymbol } from "./edit.js";
import { writeMemory, readMemory, deleteMemory, listMemories } from "./memory.js";
import { explainQuery, searchIndex, type RankMode } from "./bm25.js";
import { checkRules, parseRules, parseRulesText, type ArchRule } from "./rules.js";
import { deltaOfDiff, emptyDelta, formatDeltaPanel, readDeltaDiff } from "./delta.js";
import { EMBED_VERSION, resolveEmbedModelDir, tryLoadEmbedModel } from "./embed/model.js";
import { buildEmbeddingIndex } from "./embed/index.js";
import { readEmbeddingsFile } from "./embed/persist.js";
import { INDEX_DIR } from "./preload.js";
import { explainSemantic } from "./embed/search.js";
import { resolveEmbedEndpoint, buildEndpointIndex, encodeQueryViaEndpoint, probeEndpoint } from "./embed/endpoint.js";
import { walk, type WalkResult } from "./walk.js";
import { watchRepo, type RepoWatch } from "./mcp/watch.js";
import { toolsFor, OUTPUT_SCHEMAS, profileNames } from "./mcp/tools.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  PROGRESS_MESSAGE_SINCE,
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
  getScanParallel,
  getScanSummary,
  memoizedEmbeddingIndex,
  memoizedEmbedModel,
  scanFingerprint,
  sessionForgetFile,
  sessionInvalidate,
  warmGrammarsForWalk,
  type SessionScanOptions,
} from "./mcp/session.js";

// The public surface of this module is unchanged: everything that used to live
// here is re-exported, so `src/engine.ts`, the tests and any consumer importing
// from "./mcp.js" keep working exactly as before.
export { toolsFor, TOOLS, TOOL_META, OUTPUT_SCHEMAS, annotationsFor, TOOL_PROFILES, profileNames, toolsInProfiles } from "./mcp/tools.js";
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
  getScanParallel,
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

// A JSON-RPC response to send, or undefined for none (a notification).
type Reply = Record<string, unknown> | undefined;

function isRpcRequest(value: unknown): value is RpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const req = value as Record<string, unknown>;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return false;
  return req.id === undefined || req.id === null || typeof req.id === "number" || typeof req.id === "string";
}

function isRpcResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return response.jsonrpc === "2.0" && typeof response.method !== "string" && ("result" in response || "error" in response);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") && v.length ? (v as string[]) : undefined;
}
// A non-negative numeric argument. Also accepts the numeric STRING a JSON-Schema-less
// client may send: `"50"` used to fall through to the default in silence, which
// reads to the caller as the option being ignored.
function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
// A result count: a whole number, or absent. `limit: 2.5` used to be accepted
// and act as 2 in silence.
function wholeNum(v: unknown, key: string): number | undefined {
  const n = num(v);
  if (n !== undefined && !Number.isInteger(n)) throw new Error(`\`${key}\` must be a whole number, got ${n}`);
  return n;
}
function positiveNum(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
}
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// A `file` argument, as the index spells it: repo-relative, `/`-separated.
//
// Agents pass `./gin.go`, an absolute path they just read, or `src\a.ts`, and
// every spelling but the indexed one answered an empty `[]` — indistinguishable
// from "this file declares nothing" — or, for an edit, "no symbol matches".
// An exact indexed spelling is taken as is, so no working call changes. A path
// that names nothing indexed is an error with same-basename suggestions, since
// the empty answer is precisely what hid the mistake.
function indexedFile(scan: RepoScan, repo: string, file: string): string {
  const byRel = fileByRelFor(scan);
  if (byRel.has(file)) return file;
  const rel = relative(repo, resolve(repo, file.replaceAll("\\", "/"))).split(sep).join("/");
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`\`file\` is outside the repository: ${file}`);
  if (byRel.has(rel)) return rel;
  const name = basename(rel);
  const near = scan.files.filter((f) => basename(f.rel) === name).map((f) => f.rel).sort(byStr).slice(0, 5);
  throw new Error(
    `file not in the index: ${file}` +
      (near.length ? ` — did you mean ${near.join(", ")}?` : " (paths are repo-relative, as symbols_overview and find_symbol report them)"),
  );
}

// "There is no such symbol/type" from a lookup tool. Its text stays the
// `{ "error": ... }` JSON it always was, but it travels as a tool execution
// error (isError): it is not a result, and a declared outputSchema describes
// results. An SDK client validates structuredContent on every NON-error
// response, so `call_graph`'s notice used to surface as a -32602 protocol
// failure instead of the sentence the model needed to read.
class NotFound extends Error {}

// Tools that never scan the file tree (git/grep/memory/embed-status only) — they
// must not trigger a grammar warm. Every other tool is scan-needing and warms
// the repo's grammars first; defaulting to "warm" keeps a newly added scan tool
// correct without having to be listed here.
const SCANLESS_TOOLS = new Set([
  "workspaces", "churn", "grep",
  "write_memory", "read_memory", "list_memories", "delete_memory",
  "embed_status",
  // scan_summary counts and classifies by path only — it never parses, so the
  // grammar warm (a whole extra walk) would be pure overhead. index_status
  // walks and stats against cache.json, and never extracts either.
  "scan_summary",
  "index_status",
]);

// The repository a call is about, in its ONE canonical spelling.
//
// An explicit per-call `repo` always wins; `defaultRepo` is the server-level
// pin (`codeindex mcp --repo <dir>`) that lets a host bind one server process
// to one workspace, so agents need not know — or restate — the absolute path.
//
// The session cache, the size guard and the watcher all key on this string,
// so `/r`, `/r/`, `r` and `./r` used to be four cold scans (5.5-9 s each on a
// 5k-file repo) filling all four LRU slots with one repository. resolve() is
// the same normalization the CLI gives `--repo`; symlinks are deliberately
// NOT followed, since the root's own name is what onboard reports.
function repoRoot(args: Record<string, unknown>, defaultRepo?: string): string {
  const requested = str(args.repo) ?? defaultRepo;
  if (!requested) throw new Error("`repo` is required (absolute path to the repository root)");
  const repo = resolve(requested);
  try {
    if (!statSync(repo).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`repository root is not a readable directory: ${requested}`);
  }
  return repo;
}

// `progress` reports phase boundaries of a scan-needing call (see toolsCall).
// `walkRepo` supplies the call's walk: the --watch oracle's for the pinned
// repository, a plain walk otherwise.
// `lspPool` keeps language servers warm across the calls of one server session.
async function callTool(
  name: string,
  args: Record<string, unknown>,
  repo: string,
  progress?: (message: string) => void,
  walkRepo: (repo: string) => Promise<{ walked: WalkResult; reused: boolean }> = async (r) => ({ walked: walk(r, {}), reused: false }),
  lspPool?: LspSessionPool,
): Promise<string> {
  const scanOpts = { scope: str(args.scope), include: strArray(args.include), exclude: strArray(args.exclude) };
  // `search`'s optional structural prior. The schema's enum has already
  // rejected anything else, so a typo no longer falls back to lexical in silence.
  const rankArg = str(args.rank);
  const rankOpt: { rank?: RankMode } = rankArg === "graph" || rankArg === "lexical" ? { rank: rankArg } : {};
  // Scan-needing tools warm the present-language grammars (re-derived per call)
  // before any scan so extraction takes the AST tier; scan-less tools skip it.
  // ONE walk feeds both the warm and the scan below — see warmGrammarsForWalk.
  let walked: WalkResult | undefined;
  let preparedScan: ReturnType<typeof getScan> | undefined;
  // `workspaces` with `check` compares manifests against the link-graph, so it
  // needs the scan (and its grammars) like any graph tool.
  const scanless = SCANLESS_TOOLS.has(name) && !(name === "workspaces" && args.check === true);
  if (!scanless) {
    // An event can arrive after the request that should see it, so a warm
    // scan is trusted only against a walk: a fresh one, or the one the
    // --watch oracle proves still current (see src/mcp/watch.ts).
    const fresh = await walkRepo(repo);
    walked = fresh.walked;
    progress?.(fresh.reused ? `unchanged since the last call: ${walked.files.length} files` : `walked ${walked.files.length} files`);
    preparedScan = await getScanParallel(
      repo,
      scanOpts,
      walked,
      () => (walked ? warmGrammarsForWalk(walked) : Promise.resolve()),
    );
    progress?.(`scan ready: ${preparedScan.files.length} files`);
  }
  const readScan = (): ReturnType<typeof getScan> => preparedScan ?? getScan(repo, scanOpts, walked);
  const readArtifacts = () => getArtifacts(repo, scanOpts, walked, preparedScan);

  if (name === "scan_summary") {
    const s = getScanSummary(repo, scanOpts, walked);
    return JSON.stringify(
      { engineVersion: ENGINE_VERSION, commit: s.commit, fileCount: s.fileCount, languages: s.languages, capped: s.capped },
      null,
      2,
    );
  }
  if (name === "index_status") {
    return JSON.stringify(indexStatus(repo, scanOpts), null, 2);
  }
  if (name === "graph") {
    return renderGraphJson(readArtifacts().graph);
  }
  if (name === "symbols") {
    const { symbols } = readArtifacts();
    const lookup = str(args.name);
    if (lookup) {
      // Own keys only: the index is a plain object, so `toString`,
      // `constructor` or `__proto__` read straight off Object.prototype
      // (a function, or `{}`) instead of the empty answer.
      const defs = Object.hasOwn(symbols.defs, lookup) ? symbols.defs[lookup]! : [];
      const refs = Object.hasOwn(symbols.refs, lookup) ? symbols.refs[lookup]! : [];
      return JSON.stringify({ name: lookup, defs: args.concise === true ? defs.map((s) => symbolLocation(s, lookup)) : defs, refs }, null, 2);
    }
    return JSON.stringify(args.concise === true ? conciseSymbolIndex(symbols) : symbols, null, 2);
  }
  if (name === "callers") {
    // callerIndexFor, not buildCallerIndex: the public builder is unmemoized, so
    // this rebuilt the whole index on EVERY request (318ms per call on a 20k-file
    // repo in the project's own benchmark). The memoized one is keyed on scan
    // object identity, which the session cache preserves across calls.
    // Recall mode is option-dependent, so it cannot use the memoized index.
    const lookup = str(args.name);
    if (args.lsp === true && !lookup) throw new Error("callers with lsp:true requires `name` (or name@file)");
    const scan = readScan();
    if (args.raw === true) {
      // Every site by callee name, before any binding. One name only: the whole
      // raw index is the library's (buildRawCallerIndex), too big for a turn.
      if (!lookup) throw new Error("callers with raw:true requires `name`");
      if (args.lsp === true || args.recall === true) throw new Error("callers raw:true takes neither lsp nor recall");
      if (args.withCaller === true) throw new Error("callers raw:true already names each site's enclosing symbol: it takes no withCaller");
      return JSON.stringify(rawCallersOf(scan, lookup), null, 2);
    }
    const index = args.recall === true ? buildCallerIndex(scan, undefined, { recall: true }) : callerIndexFor(scan);
    const sited = <T extends CallerEntry>(e: T): T => (args.withCaller === true ? withCallerIds(scan, e) : e);
    if (lookup) {
      // The LSP tier parses `Parent/name@file`; hand it that spelling of
      // whichever ref form was used.
      const reading = resolveSymbolRef(scan, lookup)?.reading;
      const lspRef = reading ? formatSymbolRef(reading) : lookup;
      const found = lookupCallerEntry(index, lookup);
      const entry = found && sited(found);
      if (entry) {
        const result = args.lsp === true ? await callersWithLsp(scan, repo, lspRef, entry, { pool: lspPool }) : entry;
        return JSON.stringify(args.concise === true ? conciseCaller(result) : result, null, 2);
      }
      // A symbol that exists but binds no site says how many sites name it
      // anyway; one that does not exist at all is an error, as it is for
      // type_hierarchy, implementations and call_graph.
      const absent = explainNoCallers(scan, lookup, index);
      if (!absent) {
        const named = rawCallerSitesFor(scan, lookup).length;
        throw new Error(
          `no symbol named "${lookup}" in the index` + (named ? ` (${named} call site(s) use the name; raw:true lists them)` : ""),
        );
      }
      return JSON.stringify(args.lsp === true ? await callersWithLsp(scan, repo, lspRef, absent, { pool: lspPool }) : absent, null, 2);
    }
    const obj: Record<string, unknown> = {};
    for (const [k, v] of index) obj[k] = args.concise === true ? conciseCaller(sited(v)) : sited(v);
    return JSON.stringify(obj, null, 2);
  }
  if (name === "workspaces") {
    const info = detectWorkspaces(repo);
    const check = args.check === true ? checkWorkspaceDeps(info, readArtifacts().graph) : undefined;
    return JSON.stringify(workspaceReport(info, check), null, 2);
  }
  if (name === "churn") {
    const res = gitChurn(repo, { since: str(args.since) });
    const sorted: Record<string, number> = {};
    for (const k of [...res.churn.keys()].sort()) sorted[k] = res.churn.get(k)!;
    return JSON.stringify({ ok: res.ok, ...historyStatus(res), churn: sorted }, null, 2);
  }
  if (name === "symbols_overview") {
    const file = str(args.file);
    if (!file) throw new Error("`file` is required");
    const scan = readScan();
    const overview = symbolsOverview(scan, indexedFile(scan, repo, file));
    return JSON.stringify(args.concise === true ? overview.map((s) => symbolLocation(s, s.name)) : overview, null, 2);
  }
  if (name === "find_symbol") {
    const namePath = str(args.namePath);
    if (!namePath) throw new Error("`namePath` is required");
    const matches = findSymbol(readScan(), namePath, {
      substring: args.substring === true,
      includeBody: args.includeBody === true,
      concise: args.concise === true,
      maxResults: positiveNum(args.maxResults),
    });
    return JSON.stringify(matches, null, 2);
  }
  if (name === "find_references") {
    const symName = str(args.name);
    if (!symName) throw new Error("`name` is required");
    const scan = readScan();
    const statik = findReferences(scan, symName);
    // The static answer is computed FIRST and passed in, so the LSP tier is
    // structurally incapable of removing anything from it — it can only append
    // a labelled `lsp` block. Absent config → no block at all, byte-compat.
    // The tier locates the declared NAME on its line: pass the name a
    // qualified ref (`name@file`, `file#Parent/name`) resolved to.
    const leaf = resolveSymbolRef(scan, symName)?.reading.name ?? symName;
    const result = args.lsp === true ? await referencesWithLsp(scan, repo, leaf, statik, { pool: lspPool }) : statik;
    return JSON.stringify(args.concise === true ? conciseReferences(result) : result, null, 2);
  }
  if (name === "symbol_at") {
    const file = str(args.file);
    const line = num(args.line);
    if (!file) throw new Error("`file` is required");
    if (line === undefined || !Number.isInteger(line) || line < 1) throw new Error("`line` must be a positive integer");
    const scan = readScan();
    const files = new Set(scan.files.map((f) => f.rel));
    const rel = resolveFileArg(repo, file, (r) => files.has(r));
    if (rel === undefined) throw new Error(`no such file in the index: ${file}`);
    return JSON.stringify(symbolAt(scan, rel, line), null, 2);
  }
  if (name === "lsp_status") {
    return JSON.stringify(await lspStatus(readScan(), repo, args.probe === true), null, 2);
  }
  if (name === "replace_symbol_body" || name === "insert_after_symbol" || name === "insert_before_symbol") {
    const namePath = str(args.namePath);
    const body = typeof args.body === "string" ? args.body : undefined;
    if (!namePath || body === undefined) throw new Error("`namePath` and `body` are required");
    const line = positiveNum(args.line);
    if (args.line !== undefined && (line === undefined || !Number.isInteger(line))) {
      throw new Error("`line` must be a 1-based line number");
    }
    const scan = readScan();
    const fn = name === "replace_symbol_body" ? replaceSymbolBody : name === "insert_after_symbol" ? insertAfterSymbol : insertBeforeSymbol;
    const file = str(args.file);
    const result = fn(scan, namePath, body, file === undefined ? undefined : indexedFile(scan, repo, file), { line, strict: args.strict === true });
    // A write WE just performed must not be trusted to the stat oracle: an
    // edit landing in the same mtime tick with the same byte count would pass
    // the (size, mtimeMs) fastpath and serve a stale scan. Revoke that one
    // file's stat proof in every session entry; the next call re-reads it and
    // nothing else. (write_memory needs no invalidation: .codeindex/ is
    // excluded from the walk, so memories never enter a scan.)
    sessionForgetFile(join(scan.root, result.file));
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
    // Additive: without `limit` the payload is exactly what it always was.
    const dead = findDeadCode(readScan(), { kinds: args.kinds === "all" ? "all" : "callable", includeTail: args.includeTail === true });
    return JSON.stringify(capDeadCode(dead, num(args.limit)), null, 2);
  }
  if (name === "duplicated_literals") {
    const report = findLiteralDuplications(readScan(), {
      minFiles: positiveNum(args.minFiles),
      minCount: positiveNum(args.minCount),
      includeTests: args.includeTests === true,
    });
    const limit = num(args.limit);
    if (limit === undefined || report.duplications.length <= limit) return JSON.stringify(report, null, 2);
    // Truncation says so, same doctrine as dead_code: a capped list that looks
    // complete is worse than a shorter one that admits it.
    return JSON.stringify(
      {
        total: report.duplications.length,
        shown: limit,
        truncated: true,
        duplications: report.duplications.slice(0, limit),
        families: report.families,
      },
      null,
      2,
    );
  }
  if (name === "complexity") {
    const scan = readScan();
    if (args.risk === true) {
      // `since` was accepted by the CLI's `risk` but silently dropped here.
      const res = gitChurn(repo, { since: str(args.since) });
      const risks = riskHotspots(scan, res.churn, positiveNum(args.top));
      return JSON.stringify({ churnOk: res.ok, ...historyStatus(res), risks }, null, 2);
    }
    const file = str(args.file);
    const rel = file === undefined ? undefined : indexedFile(scan, repo, file);
    return JSON.stringify(symbolComplexity(scan, rel, positiveNum(args.top)), null, 2);
  }
  if (name === "mermaid") {
    const { graph } = readArtifacts();
    return renderMermaid(graph, { module: str(args.module), maxEdges: positiveNum(args.maxEdges) });
  }
  if (name === "onboard") {
    // getArtifacts, not a fresh build: the session cache already holds the
    // graph, and onboarding is precisely the first call of a session — paying
    // for a second pass here is paying at the worst possible moment.
    const scan = readScan();
    const { graph } = readArtifacts();
    return JSON.stringify(
      onboardBrief(scan, graph, {
        ...(positiveNum(args.budgetTokens) !== undefined ? { budgetTokens: positiveNum(args.budgetTokens)! } : {}),
        ...(args.remember === false ? { remember: false } : {}),
      }),
      null,
      2,
    );
  }
  if (name === "repo_map") {
    const { scan, graph } = readArtifacts();
    return renderRepoMap(scan, graph, { budgetTokens: positiveNum(args.budgetTokens) });
  }
  if (name === "hotspots") {
    const scan = readScan();
    const res = gitChurn(repo, { since: str(args.since) });
    const hotspots = rankHotspots(scan, res.churn, positiveNum(args.limit));
    return JSON.stringify({ churnOk: res.ok, ...historyStatus(res), hotspots }, null, 2);
  }
  if (name === "coupling") {
    const { graph } = readArtifacts();
    const res = changeCoupling(repo, {
      since: str(args.since),
      graph,
      hidden: args.hidden === true,
      minTogether: positiveNum(args.minTogether),
      maxCommitFiles: positiveNum(args.maxCommitFiles),
      maxPairs: positiveNum(args.limit),
    });
    return JSON.stringify({ ok: res.ok, ...historyStatus(res), couplings: res.couplings }, null, 2);
  }
  if (name === "grep") {
    const pattern = str(args.pattern);
    if (!pattern) throw new Error("`pattern` is required");
    // `scope` is its own predicate, ANDed with `globs` (it used to be OR-ed in
    // as one more glob, so scope+globs widened the search instead of
    // narrowing it), and may name a file as well as a directory.
    const res = grepRepoEx(repo, pattern, {
      globs: strArray(args.globs),
      scope: str(args.scope),
      ignoreCase: args.ignoreCase === true,
      maxHits: positiveNum(args.maxHits),
      filesWithMatches: args.filesWithMatches === true,
      timeoutMs: positiveNum(args.timeoutMs),
    });
    // The bare array stays the default shape. `withMeta` opts into the
    // envelope; a result the time budget cut short always gets it, since a
    // partial answer shaped like a complete one would be a silent lie.
    if (args.withMeta === true || res.timedOut) {
      const { hits, truncated, filesMatched, timedOut, notes } = res;
      return JSON.stringify({ hits, truncated, filesMatched, ...(timedOut ? { timedOut } : {}), ...(notes.length ? { notes } : {}) }, null, 2);
    }
    return JSON.stringify(res.hits, null, 2);
  }
  if (name === "search") {
    const query = str(args.query);
    if (!query) throw new Error("`query` is required");
    const limit = wholeNum(args.limit, "limit");
    const scan = readScan();
    const fuzzy = typeof args.fuzzy === "boolean" ? args.fuzzy : undefined;
    const exactOpt = args.exact === true ? { exact: true as const } : {};
    const lexOpts = { limit, fuzzy, ...exactOpt, ...rankOpt };
    if (args.semantic === true) {
      // semantic:true changes the response SHAPE (wraps the ranked list with a
      // `tier`/`degradedReason?`) so a caller can tell "fusion happened" apart
      // from "degraded to lexical" — see the `search` tool description. This
      // branch is the ONLY place that shape appears; plain lexical search below
      // stays the bare array, byte-compat for existing consumers. `exact`,
      // `rank` and `explain` mean what they mean without it, fused or degraded.
      const answer = (
        { results, explain }: { results: unknown[]; explain: unknown },
        tier: "endpoint" | "static" | "lexical",
        degradedReason?: string,
      ): string =>
        JSON.stringify(
          { results, tier, ...(degradedReason ? { degradedReason } : {}), ...(args.explain === true ? { explain } : {}) },
          null,
          2,
        );
      const endpoint = resolveEmbedEndpoint();
      if (endpoint) {
        // Rich tier — endpoint takes PRECEDENCE over a local static model. An
        // unreachable/malformed endpoint degrades to lexical, now with a reason.
        // The corpus index is memoized per (endpoint, scan state) — the query
        // itself is always re-encoded fresh (it differs per call).
        try {
          const index = await memoizedEmbeddingIndex({ mode: "endpoint", identity: endpoint, scan }, (previous) =>
            buildEndpointIndex(scan, { previous }),
          );
          const queryVec = await encodeQueryViaEndpoint(query);
          return answer(explainSemantic(scan, query, index, { ...lexOpts, queryVec }), "endpoint");
        } catch (e) {
          return answer(explainQuery(scan, query, lexOpts), "lexical", `embedding endpoint failed: ${errMessage(e)}`);
        }
      }
      const modelDir = resolveEmbedModelDir(repo);
      const { model, error: modelError } = tryLoadEmbedModel(modelDir, memoizedEmbedModel);
      if (model) {
        // First build in this process: the embeddings.bin `index` wrote, if
        // any, donates every vector whose unit text is unchanged.
        const index = await memoizedEmbeddingIndex({ mode: "static", identity: `${modelDir}#${model.modelId}`, scan }, (previous) =>
          buildEmbeddingIndex(scan, model, { previous: previous ?? readEmbeddingsFile(join(repo, INDEX_DIR, "embeddings.bin")) }),
        );
        return answer(explainSemantic(scan, query, index, { ...lexOpts, model }), "static");
      }
      // Opt-in tier not activated (no endpoint, no usable model asset) —
      // degrade to lexical with a reason instead of failing the call. A broken
      // model.json is named, since "configure one" would be the wrong advice.
      return answer(
        explainQuery(scan, query, lexOpts),
        "lexical",
        modelError ? `static model unusable: ${modelError}` : "no embedding endpoint or static model configured — see embed_status",
      );
    }
    // Plain lexical. `explain:true` wraps the array so a caller can see the
    // verdict; absent, the response is the bare array it has always been —
    // byte-compatible for every existing consumer. The `bridgedOnly` flag rides
    // INSIDE that array either way, which is the only diagnostic that reaches a
    // client that never adopts the wrapper or the explain_search tool.
    const { results, explain } = explainQuery(scan, query, lexOpts);
    return JSON.stringify(args.explain === true ? { results, explain } : results, null, 2);
  }
  if (name === "explain_search") {
    const query = str(args.query);
    if (!query) throw new Error("`query` is required");
    const limit = wholeNum(args.limit, "limit");
    const scan = readScan();
    const fuzzy = typeof args.fuzzy === "boolean" ? args.fuzzy : undefined;
    // Always an object, which is exactly why this is a tool of its own rather
    // than another shape `search` can return: a stable shape is what lets it
    // declare an outputSchema at all.
    const { results, explain } = explainQuery(scan, query, {
      limit,
      fuzzy,
      ...(args.exact === true ? { exact: true as const } : {}),
      ...rankOpt,
    });
    return JSON.stringify({ results, explain }, null, 2);
  }
  if (name === "embed_status") {
    const modelDir = resolveEmbedModelDir(repo);
    const { model, error: modelError } = tryLoadEmbedModel(modelDir, memoizedEmbedModel);
    const endpoint = resolveEmbedEndpoint();
    const mode: "none" | "static" | "endpoint" = endpoint ? "endpoint" : model ? "static" : "none";
    const status: Record<string, unknown> = {
      embedVersion: EMBED_VERSION,
      mode,
      model: model
        ? { present: true, dir: modelDir, modelId: model.modelId, dim: model.dim, vocabSize: model.vocabSize }
        : modelError
          ? { present: true, dir: modelDir, error: modelError }
          : { present: false },
      endpoint: endpoint ?? null,
    };
    if (endpoint) status.endpointReachable = await probeEndpoint(endpoint);
    return JSON.stringify(status, null, 2);
  }
  // An unknown symbol is an ERROR (isError: true) in the navigation tools, as
  // it is on the CLI (exit 2) — no longer an `{error}` object in a successful
  // result, which a client cannot tell from an answer without parsing it.
  if (name === "type_hierarchy") {
    const scan = readScan();
    const hierarchy = hierarchyFor(scan);
    const wanted = str(args.name);
    if (!wanted) {
      const obj: Record<string, unknown> = {};
      for (const [key, entry] of hierarchy) obj[key] = entry;
      return JSON.stringify(obj, null, 2);
    }
    const entry = typeEntry(hierarchy, wanted, resolveSymbolRef(scan, wanted)?.defs);
    if (!entry) throw new NotFound(`no type named ${wanted}`);
    return JSON.stringify(entry, null, 2);
  }
  if (name === "implementations") {
    const wanted = str(args.name);
    if (!wanted) throw new Error("`name` is required");
    const scan = readScan();
    const hierarchy = hierarchyFor(scan);
    const declarations = resolveSymbolRef(scan, wanted)?.defs;
    if (!typeEntry(hierarchy, wanted, declarations)) throw new NotFound(`no type named ${wanted}`);
    return JSON.stringify({ name: wanted, implementations: implementationsOf(hierarchy, wanted, declarations) }, null, 2);
  }
  if (name === "call_graph") {
    const symbol = str(args.symbol);
    if (!symbol) throw new Error("`symbol` is required");
    const direction = str(args.direction);
    const dir: Direction = direction === "out" || direction === "in" ? direction : "both";
    const result = neighborhood(symbolGraphFor(readScan()), symbol, {
      ...(positiveNum(args.depth) !== undefined ? { depth: positiveNum(args.depth)! } : {}),
      direction: dir,
    });
    if (!result.root.length) throw new NotFound(`no symbol named ${symbol}`);
    return JSON.stringify(result, null, 2);
  }
  if (name === "call_path") {
    const from = str(args.from);
    const to = str(args.to);
    if (!from || !to) throw new Error("`from` and `to` are required");
    const opts = { depth: positiveNum(args.depth), maxPaths: positiveNum(args.maxPaths) };
    if (args.files === true) {
      const { graph } = readArtifacts();
      const known = new Set(graph.files.map((f) => f.rel));
      const [a, b] = [from, to].map((arg) => {
        const rel = resolveFileArg(repo, arg, (r) => known.has(r));
        if (rel === undefined) throw new Error(`no such file in the index: ${arg}`);
        return rel;
      });
      return JSON.stringify(dependencyPath(graph, a!, b!, { ...opts, includeInferred: args.includeInferred === true }), null, 2);
    }
    if (args.includeInferred === true) throw new Error("includeInferred applies to files: true only");
    const path = callPath(symbolGraphFor(readScan()), from, to, opts);
    if (!path.from.length) throw new Error(`no symbol named ${from}`);
    if (!path.to.length) throw new Error(`no symbol named ${to}`);
    return JSON.stringify(path, null, 2);
  }
  if (name === "impact" || name === "neighbors") {
    // Pure functions of the link-graph, so the persisted artifacts answer
    // them; an agent's only file-level "what depends on X" used to be the
    // whole `graph` blob.
    const target = str(args.target);
    if (!target) throw new Error("`target` is required");
    const depth = positiveNum(args.depth);
    let kinds: Set<string> | undefined;
    if (name === "neighbors" && args.kinds !== undefined) {
      const list = strArray(args.kinds) ?? [];
      const bad = list.filter((k) => !(EDGE_KINDS as readonly string[]).includes(k));
      if (!list.length || bad.length) throw new Error(`\`kinds\` expects edge kinds among ${EDGE_KINDS.join("|")}, got ${JSON.stringify(bad.length ? bad : args.kinds)}`);
      kinds = new Set(list);
    }
    const { graph } = readArtifacts();
    for (const t of fileArgReadings(repo, target)) {
      const res =
        name === "impact"
          ? impactOf(graph, t, depth ?? Infinity, { includeInferred: args.includeInferred === true })
          : neighborsOf(graph, t, depth ?? 1, kinds);
      if (res) return JSON.stringify(res, null, 2);
    }
    throw new Error(`no such file or module in the index: ${target}`);
  }
  if (name === "check_rules") {
    // Inline `rules` stays the primary form; `configPath` is the CLI's --config,
    // which had no MCP equivalent, so a repo with a committed rules file had to
    // have it re-pasted into every call.
    const configPath = str(args.configPath);
    let rules: ArchRule[];
    if (args.rules !== undefined) rules = parseRules(args.rules); // throws a descriptive error on a malformed payload
    else if (configPath) {
      // The path comes from the client, and the error below used to echo the
      // start of whatever it named (`/etc/passwd` included): only a file
      // inside the repository is read, symlinks resolved first.
      const unreadable = new Error(`cannot read rules config ${configPath}`);
      let abs: string;
      try {
        abs = realpathSync(isAbsolute(configPath) ? configPath : join(repo, configPath));
      } catch {
        throw unreadable;
      }
      const root = realpathSync(repo);
      if (!abs.startsWith(root.endsWith(sep) ? root : root + sep)) {
        throw new Error(`rules config must be a file inside the repository: ${configPath}`);
      }
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        throw unreadable;
      }
      rules = parseRulesText(text, configPath);
    } else throw new Error("`rules` (or `configPath`) is required");
    const { scan, graph } = readArtifacts();
    return JSON.stringify(checkRules(graph, rules, { scan }), null, 2);
  }
  if (name === "delta") {
    // The CLI's review panel, for an agent that just edited files over this
    // server. The session scan is re-proven fresh on every call, so the graph
    // is the worktree's as it sits now. The diff is read first: when it is
    // empty the artifacts are not needed.
    const diff = readDeltaDiff(repo, { base: str(args.base), staged: args.staged === true });
    if ("error" in diff) throw new Error(diff.error);
    const depth = positiveNum(args.depth);
    let res = emptyDelta(diff, depth);
    if (diff.files.length) {
      const { scan, graph, symbols } = readArtifacts();
      res = deltaOfDiff(diff, graph, symbols, { depth, scan });
    }
    if (str(args.format) === "text") return formatDeltaPanel(res);
    const out = args.concise === true ? conciseDelta(res) : res;
    const limit = positiveNum(args.limit);
    // Modules are ranked highest score first, so a cap keeps the riskiest; it
    // says so, same doctrine as dead_code.
    if (limit === undefined || out.modules.length <= limit) return JSON.stringify(out, null, 2);
    return JSON.stringify({ ...out, modules: out.modules.slice(0, limit), totalModules: out.modules.length, truncated: true }, null, 2);
  }
  if (name === "resolution_report") {
    return JSON.stringify(resolutionReport(readScan(), { lang: str(args.lang), limit: positiveNum(args.limit) }), null, 2);
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
  // Advertise a NAMED SUBSET of the tools (see TOOL_PROFILES). Every advertised
  // tool's full schema rides in an agent's context on every turn, so a session
  // that only ever searches is paying for the graph analytics all day. Trims
  // what is ADVERTISED, not what is answerable: a tool left out of the profile
  // still works when called. Undefined = all tools, so no existing setup moves.
  profile?: string;
  // Watch the pinned repository (see src/mcp/watch.ts). On Linux the watcher
  // proves when nothing changed, so a call skips the walk and the stat pass;
  // elsewhere it only invalidates eagerly. Whenever it cannot prove freshness
  // a call walks exactly as without it.
  watch?: boolean;
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
  // Canonical like every per-call repo (see repoRoot): an embedder may pin a
  // relative or slash-terminated path, and the watcher's invalidations must
  // name the same session entries the calls do.
  const defaultRepo = opts.defaultRepo === undefined ? undefined : resolve(opts.defaultRepo);
  let tools = toolsFor(defaultRepo, protocolVersion, opts.profile);
  // What a call is validated against: EVERY tool, whatever the profile. A
  // profile trims what is advertised, not what is answerable, so a tool called
  // by name from outside it must be checked like any other — looking it up in
  // the advertised list found nothing and silently skipped validation. The
  // pin is what shapes `required` (it drops `repo`); the protocol version
  // never touches an inputSchema, so one map serves the whole session.
  const callable = new Map(
    (toolsFor(defaultRepo) as { name: string; inputSchema: Parameters<typeof validateArgs>[0] }[]).map((t) => [
      t.name,
      t.inputSchema,
    ]),
  );
  const watcher: RepoWatch | undefined =
    opts.watch && defaultRepo ? watchRepo(defaultRepo, (message) => process.stderr.write(`codeindex: ${message}\n`)) : undefined;
  const walkRepo = async (repo: string): Promise<{ walked: WalkResult; reused: boolean }> =>
    watcher && repo === defaultRepo ? watcher.walk() : { walked: walk(repo, {}), reused: false };
  // Language servers live as long as this session, not as long as one call:
  // spawning one per `lsp: true` query cost seconds and got pyright's
  // pre-indexing answer every time. Closed when stdin ends (src/lsp/pool.ts).
  const lspPool = new LspSessionPool();
  // No startup warm: each scan-needing tool warms the present-language grammars
  // for its repo before it runs (warmGrammarsForRepo re-derives them per call),
  // so a session that never scans — or only touches one language — loads no
  // unused wasm, and a language first seen mid-session still gets warmed.

  const send = (msg: Record<string, unknown> | Record<string, unknown>[]): void => {
    const wire = Array.isArray(msg)
      ? msg.map((entry) => ({ jsonrpc: "2.0", ...entry }))
      : { jsonrpc: "2.0", ...msg };
    process.stdout.write(JSON.stringify(wire) + "\n");
  };

  // Tool calls run ONE AT A TIME, in arrival order: results stay deterministic,
  // and a call never observes a half-applied edit or a session cache another
  // call is refilling. Everything else is answered the moment it is read. The
  // loop used to await each message before reading the next, so a `ping` sent
  // during a cold scan was answered only when the scan finished (7.6 s in the
  // audit) and a `notifications/cancelled` could not be seen until the call
  // it cancelled had already been answered.
  let callQueue: Promise<unknown> = Promise.resolve();
  // Ids of tool calls queued or running, and those the client has cancelled.
  // A cancelled call gets no response (the spec's rule): one still queued is
  // skipped, one already running finishes — an edit cannot be half-undone —
  // and its answer is dropped.
  const pendingCalls = new Set<string | number>();
  const cancelledCalls = new Set<string | number>();
  // Replies still being computed; drained before the server returns, so
  // closing stdin never loses an answer.
  const outstanding = new Set<Promise<void>>();
  const track = (reply: Promise<void>): void => {
    const settled = reply.finally(() => outstanding.delete(settled));
    outstanding.add(settled);
  };

  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
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
      if (Array.isArray(parsed) && parsed.length === 0) {
        send({ id: null, error: { code: -32600, message: "invalid request" } });
        continue;
      }
      if (Array.isArray(parsed)) {
        const replies = parsed.map(dispatch);
        // A notification-only batch has no response. Any actual responses must
        // share one JSON array, as required by JSON-RPC 2.0 — so a batch that
        // holds a tool call is answered when its last member is.
        const sendBatch = (settled: Reply[]): void => {
          const answered = settled.filter((r): r is Record<string, unknown> => r !== undefined);
          if (answered.length > 0) send(answered);
        };
        if (replies.some((r) => r instanceof Promise)) track(Promise.all(replies).then(sendBatch));
        else sendBatch(replies as Reply[]);
      } else {
        const reply = dispatch(parsed);
        if (reply instanceof Promise) track(reply.then((r) => (r ? send(r) : undefined)));
        else if (reply) send(reply);
      }
    }
    while (outstanding.size > 0) await Promise.all(outstanding);
  } finally {
    watcher?.close();
    await lspPool.close();
  }

  function dispatch(req: unknown): Reply | Promise<Reply> {
    // The server currently initiates no requests, but a peer response is
    // still a response — JSON-RPC forbids replying to it with -32600.
    if (isRpcResponse(req)) return undefined;
    if (!isRpcRequest(req)) {
      return { id: null, error: { code: -32600, message: "invalid request" } };
    }
    return handle(req);
  }

  // Synchronous for everything but a valid tool call, which is what keeps the
  // immediate replies in the order their requests arrived.
  function handle(req: RpcRequest): Reply | Promise<Reply> {
    // Only an ABSENT id denotes a notification. Explicit null is discouraged
    // by JSON-RPC but remains a request and must receive an id:null response.
    const notification = !("id" in req);
    const respond = (body: Record<string, unknown>): Reply => (notification ? undefined : { id: req.id ?? null, ...body });

    try {
      if (req.method === "initialize") {
        protocolVersion = negotiateProtocol(req.params?.protocolVersion);
        tools = toolsFor(defaultRepo, protocolVersion, opts.profile);
        return respond({
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo,
            instructions: `Available tool profiles: ${profileNames().join(", ")}. Active profile: ${opts.profile ?? "all"}. Configure profiles with --tools <profile[,profile]>. Profiles select advertised tools; known tools remain callable.`,
          },
        });
      } else if (req.method === "ping") {
        return respond({ result: {} });
      } else if (req.method === "tools/list") {
        return respond({ result: { tools } });
      } else if (req.method === "tools/call") {
        return toolsCall(req, respond);
      } else if (req.method === "notifications/cancelled") {
        const cancelled = req.params?.requestId;
        if ((typeof cancelled === "string" || typeof cancelled === "number") && pendingCalls.has(cancelled)) {
          cancelledCalls.add(cancelled);
        }
        return undefined;
      } else {
        return respond({ error: { code: -32601, message: `method not found: ${req.method}` } });
      }
    } catch (e) {
      return respond({ error: { code: -32603, message: errMessage(e) } });
    }
  }

  function toolsCall(req: RpcRequest, respond: (body: Record<string, unknown>) => Reply): Reply | Promise<Reply> {
    const params = req.params ?? {};
    // A call whose params do not have the CallToolRequest shape is a
    // malformed request — a protocol error, as the SDK server answers it.
    // `arguments: "xyz"` used to run the tool with no arguments at all.
    const rawArgs = params.arguments;
    if (typeof params.name !== "string") {
      return respond({ error: { code: -32602, message: "invalid params: tools/call requires a string `name`" } });
    }
    if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
      return respond({ error: { code: -32602, message: "invalid params: tools/call `arguments` must be an object" } });
    }
    const name = params.name;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    // Everything checkable from the request alone is checked BEFORE callTool,
    // which walks and scans the repo first — and before the queue, so a
    // mistake is answered at once even behind a slow call. An unknown tool
    // stays a tool error rather than -32602: that is what the reference SDK
    // server puts on the wire, and what clients already handle.
    const schema = callable.get(name);
    const invalid = schema ? validateArgs(schema, args) : `unknown tool: ${name}`;
    if (invalid) return respond({ result: { content: [{ type: "text", text: invalid }], isError: true } });

    // The version in force when the call ARRIVED shapes its answer, however
    // long it waits in the queue.
    const version = protocolVersion;
    const id = typeof req.id === "string" || typeof req.id === "number" ? req.id : undefined;
    if (id !== undefined) pendingCalls.add(id);
    // A first call on a large repo can run for many seconds with nothing on
    // the wire, and SDK clients time a request out at 60 s unless progress
    // arrives. When the caller supplied a progressToken, each phase boundary
    // is reported. Messages only: the result itself is untouched.
    const token = (params._meta as Record<string, unknown> | undefined)?.progressToken;
    let step = 0;
    const progress =
      typeof token === "string" || typeof token === "number"
        ? (message: string): void => {
            if (id !== undefined && cancelledCalls.has(id)) return;
            const detail = version >= PROGRESS_MESSAGE_SINCE ? { message } : {};
            send({ method: "notifications/progress", params: { progressToken: token, progress: ++step, ...detail } });
          }
        : undefined;
    const run = callQueue.then(async (): Promise<Reply> => {
      if (id !== undefined && cancelledCalls.has(id)) return undefined;
      return respond(await callResult(name, args, version, progress));
    });
    callQueue = run.catch(() => undefined);
    return run.then((reply) => {
      if (id === undefined) return reply;
      pendingCalls.delete(id);
      return cancelledCalls.delete(id) ? undefined : reply;
    });
  }

  async function callResult(
    name: string,
    args: Record<string, unknown>,
    version: string,
    progress?: (message: string) => void,
  ): Promise<Record<string, unknown>> {
    try {
      const repo = repoRoot(args, defaultRepo);
      const raw = await callTool(name, args, repo, progress, walkRepo, lspPool);
      // Narrowed or projected, the answer is not what a whole-repo artifact
      // holds, so the size guard must not point at one.
      const narrowed =
        str(args.scope) !== undefined ||
        strArray(args.include) !== undefined ||
        strArray(args.exclude) !== undefined ||
        str(args.name) !== undefined ||
        args.concise === true;
      const text = capResponse(raw, name, repo, opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, !narrowed);
      // A capped whole-repo response points at an artifact already on disk.
      // From 2025-06-18 the protocol has a content type that says exactly
      // that, so the client can fetch the bytes instead of re-asking.
      //
      // Gated on `text !== raw` — i.e. capResponse actually replaced the
      // payload. Otherwise a normal 900 KB graph would be JSON.parsed on
      // every single call just to discover it was not truncated.
      const capped = text !== raw;
      const link = capped && version >= RICH_TOOLS_SINCE ? resourceLinkFor(text, name) : undefined;
      // Typed, validatable result alongside the text block — for the tools
      // that declare an outputSchema, and never when the guard replaced the
      // payload (see structuredContentFor).
      const structured =
        version >= RICH_TOOLS_SINCE ? structuredContentFor(text, capped, OUTPUT_SCHEMAS[name] !== undefined) : undefined;
      return {
        result: {
          content: link ? [{ type: "text", text }, link] : [{ type: "text", text }],
          ...(structured ? { structuredContent: structured } : {}),
          // The withheld-payload notice is a tool execution error: the call
          // did not deliver what was asked, and the notice is exactly the
          // actionable text such an error exists to carry. It is also the
          // only honest option for a tool with an outputSchema — the notice
          // cannot conform to it, and SDK clients reject a non-error result
          // that lacks conforming structuredContent.
          ...(capped ? { isError: true } : {}),
        },
      };
    } catch (e) {
      const text = e instanceof NotFound ? JSON.stringify({ error: e.message }, null, 2) : errMessage(e);
      return { result: { content: [{ type: "text", text }], isError: true } };
    }
  }
}
