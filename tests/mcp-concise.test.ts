import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { profileNames } from "../src/mcp/tools.js";

const clientModule = new URL("../scripts/bench/mcp-client.mjs", import.meta.url).href;
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
let repo: string;
let client: any;
let handshake: any;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "ci-concise-"));
  writeFileSync(join(repo, "lib.ts"), '/** Return a friendly greeting. */\nexport function greet(name: string): string {\n return "hello " + name;\n}\nexport function unused(): void {}\n');
  writeFileSync(join(repo, "app.ts"), 'import { greet } from "./lib";\nexport function main(): void {\n greet("world");\n}\n');
  const { startMcpClient } = await import(/* @vite-ignore */ clientModule);
  client = startMcpClient(process.execPath, [CLI, "mcp", "--repo", repo, "--tools", "find,impact"], { timeoutMs: 10_000 });
  handshake = await client.handshake();
  expect(handshake.ok).toBe(true);
});
afterAll(async () => { await client?.close(); rmSync(repo, { recursive: true, force: true }); });

async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.request("tools/call", { name, arguments: args });
  expect(response.ok).toBe(true);
  expect(response.result.isError, JSON.stringify(response.result)).not.toBe(true);
  return JSON.parse(response.result.content[0].text);
}
const location = ({ name, kind, file, line }: any) => ({ name, kind, file, line });

describe("concise MCP read answers", () => {
  it("advertises each concise option and the available/active profiles", async () => {
    // handshake() is the raw initialize request result.
    const initialized = await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(initialized.result.instructions).toContain("find,impact");
    for (const name of profileNames()) expect(initialized.result.instructions).toContain(name);
    const listed = await client.request("tools/list", {});
    for (const name of ["find_references", "callers", "symbols_overview", "symbols"]) {
      expect(listed.result.tools.find((t: any) => t.name === name).inputSchema.properties.concise.type).toBe("boolean");
    }
  });
  it("projects overview declarations without changing results or subsequent default answers", async () => {
    const args = { file: "lib.ts" };
    const full = await call("symbols_overview", args);
    expect(full.length).toBe(2);
    expect(await call("symbols_overview", { ...args, concise: true })).toEqual(full.map(location));
    expect(await call("symbols_overview", args)).toEqual(full);
    expect(await call("symbols_overview", { ...args, concise: false })).toEqual(full);
  });
  it("retains all reference tiers and caller confidence", async () => {
    const full = await call("find_references", { name: "greet" });
    const concise = await call("find_references", { name: "greet", concise: true });
    expect(full.callSites).toEqual([{ file: "app.ts", line: 3 }]);
    expect(concise).toEqual({ ...full, defs: full.defs.map(location) });
    expect(JSON.stringify(concise).length).toBeLessThan(JSON.stringify(full).length);
    const callers = await call("callers", { name: "greet", recall: true });
    expect(callers.callers[0].confidence).toBe("corroborated");
    expect(await call("callers", { name: "greet", recall: true, concise: true })).toEqual({ ...callers, def: location(callers.def) });
    const index = await call("callers");
    expect(await call("callers", { concise: true })).toEqual(Object.fromEntries(Object.entries(index).map(([key, value]: [string, any]) => [key, { ...value, def: location(value.def) }])));
  });
  it("projects targeted and full symbol indexes but keeps groups and references", async () => {
    const full = await call("symbols", { name: "greet" });
    expect(await call("symbols", { name: "greet", concise: true })).toEqual({ ...full, defs: full.defs.map((d: any) => location({ ...d, name: "greet" })) });
    const index = await call("symbols");
    expect(await call("symbols", { concise: true })).toEqual({ ...index, defs: Object.fromEntries(Object.entries(index.defs).map(([name, defs]: [string, any]) => [name, defs.map((d: any) => location({ ...d, name }))])) });
    expect(await call("symbols")).toEqual(index);
  });
  it("resolves qualified targets even when the caller index stores their bare name", async () => {
    const plain = await call("callers", { name: "greet" });
    expect(await call("callers", { name: "greet@lib.ts" })).toEqual(plain);
    const enriched = await call("callers", { name: "greet@lib.ts", lsp: true, concise: true });
    expect(enriched.callers).toEqual(plain.callers);
    expect(enriched.def).toEqual(location(plain.def));
    expect(enriched.lsp.ok).toBe(false);
    expect(enriched.lsp.reason).toMatch(/config/i);
    const rejected = await client.request("tools/call", { name: "callers", arguments: { lsp: true } });
    expect(rejected.result.isError).toBe(true);
    expect(rejected.result.content[0].text).toMatch(/requires.*name/);
  });
  it("keeps empty results and LSP failure metadata intact", async () => {
    for (const tool of ["symbols", "callers", "find_references"]) {
      expect(await call(tool, { name: "doesNotExist", concise: true })).toEqual(await call(tool, { name: "doesNotExist" }));
    }
    const full = await call("find_references", { name: "greet", lsp: true });
    expect(await call("find_references", { name: "greet", lsp: true, concise: true })).toEqual({ ...full, defs: full.defs.map(location) });
  });
});
