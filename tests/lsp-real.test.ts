// Opt-in integration against an installed TypeScript language server. The
// default suite exercises the same protocol using deterministic stdio fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const command = process.env.CODEINDEX_TYPESCRIPT_LSP;
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const CLIENT = new URL("../scripts/bench/mcp-client.mjs", import.meta.url).href;
let repo: string;
let client: any;

describe.skipIf(!command)("real TypeScript LSP through shipped CLI and MCP", () => {
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "ci-real-lsp-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "lsp-fixture", private: true, type: "module" }));
    writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["*.ts"] }));
    writeFileSync(join(repo, "target.ts"), 'export function greet(name: string): string {\n return "hello " + name;\n}\n');
    writeFileSync(join(repo, "caller.ts"), 'import { greet } from "./target.js";\nexport function run(): string {\n return greet("world");\n}\n');
    mkdirSync(join(repo, ".codeindex"));
    writeFileSync(join(repo, ".codeindex/lsp.json"), JSON.stringify({ version: 1, servers: [{ id: "ts", command, args: ["--stdio"], languages: ["typescript"], initializationOptions: { tsserver: { useSyntaxServer: "never" } }, timeoutMs: 20_000, startupTimeoutMs: 20_000 }] }));
    const { startMcpClient } = await import(/* @vite-ignore */ CLIENT);
    client = startMcpClient(process.execPath, [CLI, "mcp", "--repo", repo], { timeoutMs: 60_000 });
    expect((await client.handshake()).ok).toBe(true);
  });
  afterAll(async () => { await client?.close(); if (repo) rmSync(repo, { recursive: true, force: true }); });

  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args, "--repo", repo], { encoding: "utf8", timeout: 60_000 });
  it("reports capability, finds the real call site and preserves persisted artifacts", () => {
    cli("index", "--out", join(repo, ".codeindex"));
    const graph = readFileSync(join(repo, ".codeindex/graph.json"));
    const symbols = readFileSync(join(repo, ".codeindex/symbols.json"));
    const status = JSON.parse(cli("lsp", "status", "--probe"));
    expect(status.servers[0].capabilities.callHierarchy).toBe(true);
    const statik = JSON.parse(cli("callers", "greet@target.ts"));
    const enriched = JSON.parse(cli("callers", "greet@target.ts", "--lsp"));
    expect(enriched.lsp.ok, enriched.lsp.reason).toBe(true);
    expect(enriched.lsp.calls).toEqual([{ file: "caller.ts", line: 3, character: 8, caller: { file: "caller.ts", line: 2, character: 16, name: "run", kind: 12 } }]);
    expect(enriched.lsp.agreement).toEqual({ both: ["caller.ts"], lspOnly: [], staticOnly: [] });
    const { lsp, ...unchanged } = enriched;
    expect(unchanged).toEqual(statik);
    expect(readFileSync(join(repo, ".codeindex/graph.json"))).toEqual(graph);
    expect(readFileSync(join(repo, ".codeindex/symbols.json"))).toEqual(symbols);
  }, 90_000);
  it("finds cross-file references in a short-lived semantic session", async () => {
    const response = await client.request("tools/call", { name: "find_references", arguments: { name: "greet", lsp: true, concise: true } });
    expect(response.ok).toBe(true);
    expect(response.result.isError).not.toBe(true);
    const answer = JSON.parse(response.result.content[0].text);
    expect(answer.lsp.ok, answer.lsp.reason).toBe(true);
    expect([...new Set(answer.lsp.refs.map((ref: any) => ref.file))].sort()).toEqual(["caller.ts", "target.ts"]);
    expect(answer.lsp.refs).toContainEqual({ file: "caller.ts", line: 3, character: 8 });
  }, 60_000);
  it("combines concise and LSP over the real MCP transport", async () => {
    const response = await client.request("tools/call", { name: "callers", arguments: { name: "greet", lsp: true, concise: true } });
    expect(response.ok).toBe(true);
    expect(response.result.isError).not.toBe(true);
    const answer = JSON.parse(response.result.content[0].text);
    expect(answer.def).toEqual({ name: "greet", kind: "function", file: "target.ts", line: 1 });
    expect(answer.lsp.ok, answer.lsp.reason).toBe(true);
    expect(answer.lsp.calls.map((c: any) => [c.file, c.line])).toEqual([["caller.ts", 3]]);
  }, 60_000);
});
