// Pooled language-server sessions: reuse, invalidation, lifetime, and the
// readiness guard that re-asks a server still indexing.
//
// Everything runs against the committed fake server through the REAL spawn,
// except the warm-session test, which scripts an in-memory session to count
// requests exactly. The last block starts the shipped MCP server and proves no
// language server outlives it.

import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { callersWithLsp, referencesWithLsp, LspSessionPool } from "../src/lsp/index.js";
import type { LspSession, LspTransport } from "../src/lsp/client.js";
import type { OpenResult } from "../src/lsp/pool.js";
import { findReferences } from "../src/query.js";
import { scanRepo } from "../src/scan.js";

const MINI = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/lsp/fake-server.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

// `helper` is declared at src/helpers.ts:1 and called at src/client.ts:7.
const FULL = [
  { file: "src/client.ts", line: 7, character: 19 },
  { file: "src/helpers.ts", line: 1, character: 13 },
];

const temporary: string[] = [];
const pools: LspSessionPool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWith(env: Record<string, string>, extra: Record<string, unknown> = {}): { repo: string; pidfile: string } {
  const dir = mkdtempSync(join(tmpdir(), "codeindex-lsp-pool-"));
  temporary.push(dir);
  const repo = join(dir, "repo");
  const pidfile = join(dir, "pids");
  cpSync(MINI, repo, { recursive: true });
  mkdirSync(join(repo, ".codeindex"), { recursive: true });
  writeFileSync(
    join(repo, ".codeindex", "lsp.json"),
    JSON.stringify({
      version: 1,
      servers: [
        {
          id: "fake",
          languages: ["typescript", "javascript"],
          command: process.execPath,
          args: [FAKE],
          env: { FAKE_LSP_ROOT: repo, FAKE_LSP_REFS: JSON.stringify(FULL), FAKE_LSP_PIDFILE: pidfile, ...env },
          timeoutMs: 4000,
          startupTimeoutMs: 8000,
          ...extra,
        },
      ],
    }),
  );
  return { repo, pidfile };
}

const pids = (pidfile: string): number[] =>
  existsSync(pidfile) ? readFileSync(pidfile, "utf8").split("\n").filter(Boolean).map(Number) : [];

/** Alive and not a zombie: an exited child whose parent is gone may linger unreaped. */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    if (existsSync("/proc/self/stat")) return false; // Linux, and no such pid
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

const ask = (repo: string, pool?: LspSessionPool) => {
  const scan = scanRepo(repo);
  return referencesWithLsp(scan, repo, "helper", findReferences(scan, "helper"), pool ? { pool } : {});
};

describe("LspSessionPool", () => {
  it("answers every query from one server, where no pool spawns one per query", async () => {
    const { repo, pidfile } = repoWith({});
    const pool = new LspSessionPool();
    pools.push(pool);
    for (let i = 0; i < 3; i++) expect((await ask(repo, pool)).lsp?.ok).toBe(true);
    expect(pids(pidfile)).toHaveLength(1);
    expect(pool.size).toBe(1);

    for (let i = 0; i < 2; i++) expect((await ask(repo)).lsp?.ok).toBe(true);
    expect(pids(pidfile)).toHaveLength(3);
  }, 30_000);

  it("restarts the server when code changes, but not for a doc edit", async () => {
    const { repo, pidfile } = repoWith({});
    const pool = new LspSessionPool();
    pools.push(pool);
    await ask(repo, pool);
    appendFileSync(join(repo, "docs", "guide.md"), "\nAnother paragraph.\n");
    await ask(repo, pool);
    expect(pids(pidfile)).toHaveLength(1);

    // The server may have read the old text; it must not answer for the new.
    appendFileSync(join(repo, "src", "helpers.ts"), "export const other = 2;\n");
    const answer = await ask(repo, pool);
    expect(answer.lsp?.ok).toBe(true);
    const [first, second] = pids(pidfile);
    expect(second).toBeDefined();
    expect(await until(() => !alive(first!))).toBe(true);
    expect(alive(second!)).toBe(true);
  }, 30_000);

  it("restarts the server when its config changes", async () => {
    const { repo, pidfile } = repoWith({});
    const pool = new LspSessionPool();
    pools.push(pool);
    await ask(repo, pool);
    const path = join(repo, ".codeindex", "lsp.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.servers[0].timeoutMs = 3000;
    writeFileSync(path, JSON.stringify(config));
    await ask(repo, pool);
    expect(pids(pidfile)).toHaveLength(2);
  }, 30_000);

  it("replaces a pooled server that died between queries", async () => {
    const { repo, pidfile } = repoWith({});
    const pool = new LspSessionPool();
    pools.push(pool);
    await ask(repo, pool);
    const [first] = pids(pidfile);
    process.kill(first!, "SIGKILL");
    expect(await until(() => !alive(first!))).toBe(true);
    const answer = await ask(repo, pool);
    expect(answer.lsp?.ok, answer.lsp?.reason).toBe(true);
    expect(answer.lsp?.refs.map((ref) => ref.file)).toEqual(["src/client.ts", "src/helpers.ts"]);
    expect(pids(pidfile)).toHaveLength(2);
  }, 30_000);

  it("shuts an idle server down", async () => {
    const { repo, pidfile } = repoWith({});
    const pool = new LspSessionPool({ idleMs: 150 });
    pools.push(pool);
    await ask(repo, pool);
    const [pid] = pids(pidfile);
    expect(await until(() => !alive(pid!))).toBe(true);
    expect(pool.size).toBe(0);
    // And the next query simply starts another.
    expect((await ask(repo, pool)).lsp?.ok).toBe(true);
    expect(pids(pidfile)).toHaveLength(2);
  }, 30_000);

  it("close() stops a server that ignores `exit` and a closed stdin", async () => {
    const { repo, pidfile } = repoWith({ FAKE_LSP_MODE: "stubborn" });
    const pool = new LspSessionPool();
    await ask(repo, pool);
    const [pid] = pids(pidfile);
    expect(alive(pid!)).toBe(true);
    await pool.close();
    expect(await until(() => !alive(pid!))).toBe(true);
    expect(process.listeners("exit")).not.toContain((pool as unknown as { killAll: unknown }).killAll);
  }, 30_000);
});

describe("readiness guard", () => {
  it("re-asks a server whose first answer is only the declaration", async () => {
    const { repo } = repoWith({ FAKE_LSP_WARMUP: "1" });
    const answer = await ask(repo);
    expect(answer.lsp?.ok).toBe(true);
    expect(answer.lsp?.partial).toBeUndefined();
    expect(answer.lsp?.refs.map((ref) => ref.file)).toEqual(["src/client.ts", "src/helpers.ts"]);
    expect(answer.lsp?.agreement.staticOnly).toEqual([]);
  }, 30_000);

  it("labels an answer that stays declaration-only as partial", async () => {
    const { repo } = repoWith({ FAKE_LSP_WARMUP: "1000" });
    const answer = await ask(repo);
    expect(answer.lsp?.ok).toBe(true);
    expect(answer.lsp?.partial).toBe(true);
    expect(answer.lsp?.reason).toMatch(/^fake: answered with declarations only .* may still be indexing/);
    expect(answer.lsp?.refs).toEqual([{ file: "src/helpers.ts", line: 1, character: 13 }]);
  }, 30_000);

  it("does not wait on a symbol the static tier never saw used", async () => {
    // HttpClient has no static call sites: a declaration-only answer is the
    // expected one, not a sign of indexing.
    const { repo } = repoWith({ FAKE_LSP_WARMUP: "1000" });
    const scan = scanRepo(repo);
    const started = Date.now();
    const answer = await referencesWithLsp(scan, repo, "HttpClient", findReferences(scan, "HttpClient"));
    expect(answer.lsp?.ok).toBe(true);
    expect(answer.lsp?.partial).toBeUndefined();
    expect(answer.lsp?.reason).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1500);
  }, 30_000);

  it("believes a warm session's declaration-only answer and does not retry it", async () => {
    const { repo } = repoWith({});
    let requests = 0;
    const scripted = (): OpenResult => {
      const session: LspSession = {
        capabilities: { references: true, definition: false, implementation: false, typeHierarchy: false, callHierarchy: true },
        didOpen() {},
        async references(rel, line, character) {
          requests++;
          // Full the first time, declaration-only after: homonyms, not indexing.
          return requests === 1 ? FULL : [{ file: rel, line, character }];
        },
        async definition() { return []; },
        async incomingCalls() { return []; },
        async shutdown() {},
        alive: () => true,
      };
      const transport: LspTransport = { write() {}, onData() {}, onExit() {}, close() {} };
      return { ok: true, session, transport };
    };
    const pool = new LspSessionPool({ open: async () => scripted() });
    pools.push(pool);
    expect((await ask(repo, pool)).lsp?.partial).toBeUndefined();
    expect(requests).toBe(1);
    const second = await ask(repo, pool);
    expect(second.lsp?.partial).toBeUndefined();
    expect(second.lsp?.refs).toEqual([{ file: "src/helpers.ts", line: 1, character: 13 }]);
    expect(requests).toBe(2);

    // The same answers from a session that never proved itself are retried,
    // then labelled.
    requests = 1;
    const cold = new LspSessionPool({ open: async () => scripted() });
    pools.push(cold);
    const thin = await ask(repo, cold);
    expect(thin.lsp?.partial).toBe(true);
    expect(requests).toBe(1 + 5);

    // Callers: no incoming calls while static callers exist is the same case.
    const calls = await callersWithLsp(scanRepo(repo), repo, "helper", { callers: [{ file: "src/client.ts", line: 7 }] }, { pool: cold });
    expect(calls.lsp?.ok).toBe(true);
    expect(calls.lsp?.partial).toBe(true);
    expect(calls.lsp?.reason).toMatch(/may still be indexing/);
  }, 30_000);
});

describe("no language server outlives the MCP server", () => {
  /** Start `codeindex mcp`, run one lsp:true query, return the child. */
  async function mcpWithOneQuery(repo: string) {
    const child = spawn(process.execPath, [CLI, "mcp", "--repo", repo], { stdio: ["pipe", "pipe", "inherit"] });
    let buffer = "";
    const replies = new Map<number, unknown>();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          const message = JSON.parse(line);
          replies.set(message.id, message);
        }
      }
    });
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_references", arguments: { name: "helper", lsp: true } } });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "find_references", arguments: { name: "helper", lsp: true } } });
    expect(await until(() => replies.has(3), 20_000)).toBe(true);
    for (const id of [2, 3]) {
      const reply = replies.get(id) as { result: { content: { text: string }[] } };
      expect(JSON.parse(reply.result.content[0]!.text).lsp.ok).toBe(true);
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    return { child, exited };
  }

  it("stops them when its stdin ends", async () => {
    const { repo, pidfile } = repoWith({ FAKE_LSP_MODE: "stubborn" });
    const { child, exited } = await mcpWithOneQuery(repo);
    const spawned = pids(pidfile);
    expect(spawned).toHaveLength(1); // two queries, one server
    child.stdin.end();
    await exited;
    expect(await until(() => !alive(spawned[0]!))).toBe(true);
  }, 40_000);

  it("stops them when it is terminated by a signal", async () => {
    const { repo, pidfile } = repoWith({ FAKE_LSP_MODE: "stubborn" });
    const { child, exited } = await mcpWithOneQuery(repo);
    const [pid] = pids(pidfile);
    child.kill("SIGTERM");
    await exited;
    // The default outcome of the signal is preserved.
    expect(child.signalCode).toBe("SIGTERM");
    expect(await until(() => !alive(pid!))).toBe(true);
  }, 40_000);
});
