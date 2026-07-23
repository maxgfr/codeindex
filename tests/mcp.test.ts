import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

interface RpcMsg {
  id?: number;
  result?: {
    protocolVersion?: string;
    serverInfo?: { name: string };
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

// Drive the bundle as an MCP stdio server: send the handshake + requests,
// collect one JSON response per line, resolve when every id has answered.
function mcpSession(requests: Record<string, unknown>[]): Promise<Map<number, RpcMsg>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
    const expected = new Set(requests.filter((r) => r.id !== undefined).map((r) => r.id as number));
    const got = new Map<number, RpcMsg>();
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`mcp timeout — got ids ${[...got.keys()].join(",")}`));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as RpcMsg;
        if (typeof msg.id === "number") got.set(msg.id, msg);
        if (got.size === expected.size) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(got);
        }
      }
    });
    child.on("error", reject);
    for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...r }) + "\n");
    child.stdin.end();
  });
}

// Same harness but the requests go out as ONE JSON-RPC batch array line.
function mcpBatch(requests: Record<string, unknown>[]): Promise<Map<number, RpcMsg>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
    const expected = new Set(requests.filter((r) => r.id !== undefined).map((r) => r.id as number));
    const got = new Map<number, RpcMsg>();
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("mcp batch timeout"));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as RpcMsg;
        if (typeof msg.id === "number") got.set(msg.id, msg);
        if (got.size === expected.size) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(got);
        }
      }
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify(requests.map((r) => ({ jsonrpc: "2.0", ...r }))) + "\n");
    child.stdin.end();
  });
}

describe("MCP server", () => {
  it("handshakes, lists tools, and executes tool calls", async () => {
    const res = await mcpSession([
      { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
      { id: 3, method: "tools/call", params: { name: "scan_summary", arguments: { repo: REPO } } },
      { id: 4, method: "tools/call", params: { name: "grep", arguments: { repo: REPO, pattern: "func" } } },
      { id: 5, method: "tools/call", params: { name: "callers", arguments: { repo: REPO } } },
      { id: 6, method: "tools/call", params: { name: "nope", arguments: { repo: REPO } } },
      { id: 7, method: "tools/call", params: { name: "search", arguments: { repo: REPO, query: "http client retry" } } },
      {
        id: 8,
        method: "tools/call",
        params: {
          name: "check_rules",
          arguments: { repo: REPO, rules: [{ name: "no-src-from-pkg", from: "pkg/**", to: "src/**" }] },
        },
      },
      { id: 9, method: "tools/call", params: { name: "embed_status", arguments: { repo: REPO } } },
      { id: 10, method: "tools/call", params: { name: "search", arguments: { repo: REPO, query: "http client retry", semantic: true } } },
    ]);

    expect(res.get(1)!.result!.serverInfo!.name).toBe("codeindex");
    const toolNames = res.get(2)!.result!.tools!.map((t) => t.name);
    expect(toolNames).toEqual(["scan_summary", "graph", "symbols", "callers", "workspaces", "churn", "symbols_overview", "find_symbol", "find_references", "repo_map", "hotspots", "coupling", "replace_symbol_body", "insert_after_symbol", "insert_before_symbol", "write_memory", "read_memory", "list_memories", "delete_memory", "dead_code", "complexity", "mermaid", "grep", "search", "embed_status", "check_rules"]);

    const summary = JSON.parse(res.get(3)!.result!.content![0]!.text) as { fileCount: number };
    expect(summary.fileCount).toBeGreaterThan(0);

    const hits = JSON.parse(res.get(4)!.result!.content![0]!.text) as { file: string }[];
    expect(hits.length).toBeGreaterThan(0);

    expect(res.get(5)!.result!.isError).toBeUndefined();
    expect(res.get(6)!.result!.isError).toBe(true);

    const search = JSON.parse(res.get(7)!.result!.content![0]!.text) as { file: string }[];
    expect(search.length).toBeGreaterThan(0);
    expect(search[0]!.file).toBe("src/client.ts");

    const violations = JSON.parse(res.get(8)!.result!.content![0]!.text) as unknown[];
    expect(Array.isArray(violations)).toBe(true);

    // embed_status: no model asset in the fixture repo → present:false, but the
    // tier reports its EMBED_VERSION regardless.
    const status = JSON.parse(res.get(9)!.result!.content![0]!.text) as { model: { present: boolean }; embedVersion: number };
    expect(status.model.present).toBe(false);
    expect(typeof status.embedVersion).toBe("number");

    // search with semantic:true and no model → silently degrades to lexical.
    expect(res.get(10)!.result!.isError).toBeUndefined();
    const sem = JSON.parse(res.get(10)!.result!.content![0]!.text) as { file: string }[];
    expect(sem[0]!.file).toBe("src/client.ts");
  }, 20_000);

  it("answers every member of a JSON-RPC batch", async () => {
    const res = await mcpBatch([
      { id: 1, method: "ping" },
      { id: 2, method: "tools/list" },
    ]);
    expect(res.get(1)!.result).toEqual({});
    expect(res.get(2)!.result!.tools!.length).toBeGreaterThan(0);
  }, 20_000);
});
