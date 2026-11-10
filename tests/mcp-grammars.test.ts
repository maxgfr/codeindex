// A grammar that becomes available WHILE an MCP server runs (`grammars pull`
// in another terminal). The session kept its regex-tier records for unchanged
// files next to AST-tier records for new ones: an index no cold build produces.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPTS = fileURLToPath(new URL("../scripts", import.meta.url));
const CLI = join(SCRIPTS, "cli.mjs");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-mcp-grammars-"));
  dirs.push(dir);
  return dir;
}

// One server over stdio; `call` resolves with the tool's parsed JSON answer.
function server(repo: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [CLI, "mcp", "--repo", repo], { stdio: ["pipe", "pipe", "inherit"], env });
  const waiting = new Map<number, (message: { result: { content: { text: string }[] } }) => void>();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  let nextId = 1;
  const request = (method: string, params: unknown) =>
    new Promise<{ result: { content: { text: string }[] } }>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    start: () => request("initialize", { protocolVersion: "2024-11-05", capabilities: {} }),
    call: async (name: string, args: Record<string, unknown>) => JSON.parse((await request("tools/call", { name, arguments: args })).result.content[0]!.text),
    stop: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.stdin.end();
      }),
  };
}

describe("a grammar that appears during an MCP session", () => {
  it("re-extracts the files it parses, instead of keeping their regex-tier records", async () => {
    const repo = join(scratch(), "repo");
    mkdirSync(repo, { recursive: true });
    // The regex tier sees the class; only the AST tier sees its members.
    const source = "export class Store {\n  count = 0;\n  bump(by: number): number {\n    return this.count + by;\n  }\n}\n";
    writeFileSync(join(repo, "store.ts"), source);
    // A grammars directory holding the runtime, and no TypeScript grammar yet.
    const grammars = join(scratch(), "grammars");
    mkdirSync(grammars);
    copyFileSync(join(SCRIPTS, "grammars", "web-tree-sitter.wasm"), join(grammars, "web-tree-sitter.wasm"));
    const env = { ...process.env, CODEINDEX_GRAMMAR_DIR: grammars, CODEINDEX_EMBED_DIR: "" };
    const members = (overview: { name: string }[]): string[] => overview.map((s) => s.name).sort();

    const session = server(repo, env);
    try {
      await session.start();
      const before = members(await session.call("symbols_overview", { file: "store.ts" }));
      expect(before).toEqual(["Store"]);

      // `grammars pull`, as far as the server can tell: the wasm is now there.
      copyFileSync(join(SCRIPTS, "grammars", "typescript.wasm"), join(grammars, "typescript.wasm"));
      const after = members(await session.call("symbols_overview", { file: "store.ts" }));
      // store.ts itself did not change: only the tier it can be extracted at.
      expect(after).toEqual(["Store", "bump", "count"]);

      // And what a server started now answers.
      const cold = server(repo, env);
      try {
        await cold.start();
        expect(members(await cold.call("symbols_overview", { file: "store.ts" }))).toEqual(after);
      } finally {
        await cold.stop();
      }
    } finally {
      await session.stop();
    }
  }, 60_000);
});
