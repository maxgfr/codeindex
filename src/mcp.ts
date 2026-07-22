// MCP (Model Context Protocol) server over stdio — hand-rolled JSON-RPC 2.0 so
// the engine stays zero-dependency. Newline-delimited JSON messages, protocol
// 2024-11-05 (compatible with later revisions' initialize handshake). Exposes
// the engine's read-only indexing capabilities as MCP tools; every tool takes a
// `repo` path and returns JSON text content.
//
// Register in an MCP client as:  node scripts/engine.mjs mcp
import { createInterface } from "node:readline";
import { ENGINE_VERSION } from "./types.js";
import { ensureGrammars, allGrammarKeys } from "./ast/loader.js";
import { buildIndexArtifacts } from "./pipeline.js";
import { renderGraphJson } from "./render/graph-json.js";
import { scanRepo } from "./scan.js";
import { buildCallerIndex } from "./callers.js";
import { detectWorkspaces } from "./workspaces.js";
import { gitChurn } from "./git.js";
import { grepRepo } from "./grep.js";

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
] as const;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") && v.length ? (v as string[]) : undefined;
}

function callTool(name: string, args: Record<string, unknown>): string {
  const repo = str(args.repo);
  if (!repo) throw new Error("`repo` is required (absolute path to the repository root)");
  const scanOpts = { scope: str(args.scope), include: strArray(args.include), exclude: strArray(args.exclude) };

  if (name === "scan_summary") {
    const scan = scanRepo(repo, scanOpts);
    return JSON.stringify(
      { engineVersion: ENGINE_VERSION, commit: scan.commit, fileCount: scan.files.length, languages: scan.languages, capped: scan.capped },
      null,
      2,
    );
  }
  if (name === "graph") {
    return renderGraphJson(buildIndexArtifacts(repo, scanOpts).graph);
  }
  if (name === "symbols") {
    const { symbols } = buildIndexArtifacts(repo, scanOpts);
    const lookup = str(args.name);
    if (lookup) {
      return JSON.stringify({ name: lookup, defs: symbols.defs[lookup] ?? [], refs: symbols.refs[lookup] ?? [] }, null, 2);
    }
    return JSON.stringify(symbols, null, 2);
  }
  if (name === "callers") {
    const index = buildCallerIndex(scanRepo(repo, scanOpts));
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
  throw new Error(`unknown tool: ${name}`);
}

export async function runMcpServer(): Promise<void> {
  await ensureGrammars(allGrammarKeys()); // AST tier when the sidecar is present

  const send = (msg: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  };

  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed) as RpcRequest;
    } catch {
      send({ id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    if (req.id === undefined || req.id === null) continue; // notification — no response

    try {
      if (req.method === "initialize") {
        send({
          id: req.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "codeindex", version: ENGINE_VERSION },
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
          const text = callTool(name, args);
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
