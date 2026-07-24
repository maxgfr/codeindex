import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getArtifacts, getScan, memoizedEmbeddingIndex, memoizedEmbedModel, scanFingerprint, toCacheMap } from "../src/mcp.js";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { headCommit } from "../src/git.js";
import { renderGraphJson } from "../src/render/graph-json.js";
import { renderSymbolsJson } from "../src/render/symbols-json.js";
import type { RepoScan } from "../src/scan.js";
import type { FileRecord, Graph, SymbolIndex } from "../src/types.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const ENGINE = fileURLToPath(new URL("../scripts/engine.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const MODEL_DIR = fileURLToPath(new URL("./fixtures/embed-model", import.meta.url));

interface RpcMsg {
  id?: number;
  result?: {
    protocolVersion?: string;
    serverInfo?: { name: string; version?: string };
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

// Drive the bundle as an MCP stdio server: send the handshake + requests,
// collect one JSON response per line, resolve when every id has answered.
// `env` overrides/extends the child's environment (e.g. CODEINDEX_EMBED_DIR
// to exercise the static embedding tier) on top of the parent's process.env.
// `argv` swaps the spawned entry point (default: the CLI's `mcp` command) —
// lets a test drive runMcpServer through a custom embedding launcher.
function mcpSession(
  requests: Record<string, unknown>[],
  env?: Record<string, string | undefined>,
  argv: string[] = [CLI, "mcp"],
): Promise<Map<number, RpcMsg>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, argv, {
      stdio: ["pipe", "pipe", "inherit"],
      env: env ? { ...process.env, ...env } : process.env,
    });
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

    // semantic not requested → response is the bare ranked array, byte-compat
    // (no wrapping object, no `tier` field).
    const searchText = res.get(7)!.result!.content![0]!.text;
    expect(searchText).not.toContain('"tier"');
    const search = JSON.parse(searchText) as { file: string }[];
    expect(Array.isArray(search)).toBe(true);
    expect(search.length).toBeGreaterThan(0);
    expect(search[0]!.file).toBe("src/client.ts");

    const violations = JSON.parse(res.get(8)!.result!.content![0]!.text) as unknown[];
    expect(Array.isArray(violations)).toBe(true);

    // embed_status: no model asset in the fixture repo → present:false, but the
    // tier reports its EMBED_VERSION regardless.
    const status = JSON.parse(res.get(9)!.result!.content![0]!.text) as { model: { present: boolean }; embedVersion: number };
    expect(status.model.present).toBe(false);
    expect(typeof status.embedVersion).toBe("number");

    // search with semantic:true and no endpoint/model configured → degrades to
    // lexical, but now REPORTS it via tier/degradedReason instead of silently.
    expect(res.get(10)!.result!.isError).toBeUndefined();
    const sem = JSON.parse(res.get(10)!.result!.content![0]!.text) as {
      results: { file: string }[];
      tier: string;
      degradedReason?: string;
    };
    expect(sem.tier).toBe("lexical");
    expect(sem.degradedReason).toMatch(/endpoint|model/i);
    expect(sem.results[0]!.file).toBe("src/client.ts");
  }, 20_000);

  it("search semantic:true with a static model fixture reports tier: static", async () => {
    const res = await mcpSession(
      [
        { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
        { method: "notifications/initialized" },
        {
          id: 2,
          method: "tools/call",
          params: { name: "search", arguments: { repo: REPO, query: "http client retry", semantic: true } },
        },
      ],
      { CODEINDEX_EMBED_DIR: MODEL_DIR, CODEINDEX_EMBED_ENDPOINT: undefined },
    );

    expect(res.get(2)!.result!.isError).toBeUndefined();
    const sem = JSON.parse(res.get(2)!.result!.content![0]!.text) as {
      results: { file: string; semanticSymbol?: string }[];
      tier: string;
      degradedReason?: string;
    };
    expect(sem.tier).toBe("static");
    expect(sem.degradedReason).toBeUndefined();
    expect(sem.results.length).toBeGreaterThan(0);
  }, 20_000);

  it("search semantic:true with a configured but unreachable endpoint reports tier: lexical with the failure reason", async () => {
    // A URL guaranteed to refuse connections: bind a port, then free it.
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const deadUrl = `http://127.0.0.1:${port}`;

    const res = await mcpSession(
      [
        { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
        { method: "notifications/initialized" },
        {
          id: 2,
          method: "tools/call",
          params: { name: "search", arguments: { repo: REPO, query: "http client retry", semantic: true } },
        },
      ],
      { CODEINDEX_EMBED_ENDPOINT: deadUrl, CODEINDEX_EMBED_DIR: undefined },
    );

    expect(res.get(2)!.result!.isError).toBeUndefined();
    const sem = JSON.parse(res.get(2)!.result!.content![0]!.text) as {
      results: { file: string }[];
      tier: string;
      degradedReason?: string;
    };
    // Distinct from the "nothing configured" reason — this one carries the
    // actual (short) failure, an endpoint that IS configured but unreachable.
    expect(sem.tier).toBe("lexical");
    expect(sem.degradedReason).toBeDefined();
    expect(sem.degradedReason).toMatch(/embedding endpoint failed/i);
    expect(sem.results[0]!.file).toBe("src/client.ts");
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

// --- Fix C: embedding index memoization -------------------------------------

// Minimal hand-built RepoScan (bm25.test.ts/embed.test.ts style): scanFingerprint
// only reads rel + hash, so a bare-bones FileRecord isolates its behavior.
function fingerprintFile(rel: string, hash: string): FileRecord {
  return { rel, ext: ".ts", size: 0, lines: 1, hash, kind: "code", lang: "typescript", headings: [], symbols: [], refs: [] };
}
function fingerprintScanOf(files: FileRecord[]): RepoScan {
  return { root: "/repo", files, languages: {}, docText: new Map(), mtimes: new Map(), capped: false, excluded: 0, contentUnchanged: false, cacheDirty: true };
}

describe("scanFingerprint", () => {
  it("is stable for identical (rel, hash) pairs and changes on edit/add/remove", () => {
    const a = fingerprintScanOf([fingerprintFile("a.ts", "h1"), fingerprintFile("b.ts", "h2")]);
    const aAgain = fingerprintScanOf([fingerprintFile("a.ts", "h1"), fingerprintFile("b.ts", "h2")]);
    expect(scanFingerprint(a)).toBe(scanFingerprint(aAgain));

    const edited = fingerprintScanOf([fingerprintFile("a.ts", "h1-edited"), fingerprintFile("b.ts", "h2")]);
    expect(scanFingerprint(edited)).not.toBe(scanFingerprint(a));

    const added = fingerprintScanOf([fingerprintFile("a.ts", "h1"), fingerprintFile("b.ts", "h2"), fingerprintFile("c.ts", "h3")]);
    expect(scanFingerprint(added)).not.toBe(scanFingerprint(a));

    const removed = fingerprintScanOf([fingerprintFile("a.ts", "h1")]);
    expect(scanFingerprint(removed)).not.toBe(scanFingerprint(a));
  });
});

describe("memoizedEmbeddingIndex (single-entry cache)", () => {
  it("reuses the cached index across calls with the same key — build runs once", async () => {
    const scan = fingerprintScanOf([fingerprintFile("a.ts", "h1")]);
    let calls = 0;
    const build = () => {
      calls++;
      return { embedVersion: 1, modelId: "m", dim: 1, records: [] };
    };
    const i1 = await memoizedEmbeddingIndex({ mode: "static", identity: "unit-a", scan }, build);
    const i2 = await memoizedEmbeddingIndex({ mode: "static", identity: "unit-a", scan }, build);
    expect(calls).toBe(1);
    expect(i2).toBe(i1); // same cached object, not a fresh build
  });

  it("rebuilds when the scan fingerprint changes (a file was edited/added/removed)", async () => {
    const scan = fingerprintScanOf([fingerprintFile("a.ts", "h1")]);
    let calls = 0;
    const build = () => {
      calls++;
      return { embedVersion: 1, modelId: "m", dim: 1, records: [] };
    };
    const i1 = await memoizedEmbeddingIndex({ mode: "static", identity: "unit-b", scan }, build);
    const changed = fingerprintScanOf([fingerprintFile("a.ts", "h1-changed")]);
    const i2 = await memoizedEmbeddingIndex({ mode: "static", identity: "unit-b", scan: changed }, build);
    expect(calls).toBe(2);
    expect(i2).not.toBe(i1);
  });

  it("rebuilds when mode/identity changes even though the scan is unchanged", async () => {
    const scan = fingerprintScanOf([fingerprintFile("a.ts", "h1")]);
    let calls = 0;
    const build = () => {
      calls++;
      return { embedVersion: 1, modelId: "m", dim: 1, records: [] };
    };
    await memoizedEmbeddingIndex({ mode: "static", identity: "unit-c-static", scan }, build);
    await memoizedEmbeddingIndex({ mode: "endpoint", identity: "unit-c-endpoint", scan }, build);
    expect(calls).toBe(2);
  });

  it("never caches a failed build — the next call retries from scratch", async () => {
    const scan = fingerprintScanOf([fingerprintFile("a.ts", "h1")]);
    let calls = 0;
    const build = () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return { embedVersion: 1, modelId: "m", dim: 1, records: [] };
    };
    await expect(memoizedEmbeddingIndex({ mode: "static", identity: "unit-d", scan }, build)).rejects.toThrow("boom");
    expect(calls).toBe(1);
    const index = await memoizedEmbeddingIndex({ mode: "static", identity: "unit-d", scan }, build);
    expect(calls).toBe(2);
    expect(index.dim).toBe(1);
  });
});

describe("memoizedEmbedModel (single-entry static-model cache)", () => {
  const modelJson = (modelId: string) => JSON.stringify({ modelId, dim: 1, vocab: ["a"], weights: [[1]] });

  it("same (dir, mtime, size) returns the SAME parsed instance — no re-read", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-model-memo-"));
    writeFileSync(join(dir, "model.json"), modelJson("memo-same"));
    const m1 = memoizedEmbedModel(dir);
    const m2 = memoizedEmbedModel(dir);
    expect(m1?.modelId).toBe("memo-same");
    expect(m2).toBe(m1); // cached object, not a fresh parse
  });

  it("an in-place re-pull (changed model.json) invalidates the cache and reloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-model-memo-"));
    writeFileSync(join(dir, "model.json"), modelJson("memo-v1"));
    const m1 = memoizedEmbedModel(dir);
    // A different byte length changes the size component of the key, so the
    // cache invalidates even where the filesystem's mtime granularity is coarse.
    writeFileSync(join(dir, "model.json"), modelJson("memo-v2-longer"));
    const m2 = memoizedEmbedModel(dir);
    expect(m1?.modelId).toBe("memo-v1");
    expect(m2?.modelId).toBe("memo-v2-longer");
    expect(m2).not.toBe(m1);
  });

  it("returns undefined when the dir has no model.json (the not-present case)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-model-memo-"));
    expect(memoizedEmbedModel(dir)).toBeUndefined();
  });

  it("never caches a failed load — the throw propagates, then a now-valid file loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-model-memo-"));
    writeFileSync(join(dir, "model.json"), "{ this is not JSON");
    expect(() => memoizedEmbedModel(dir)).toThrow();
    writeFileSync(join(dir, "model.json"), modelJson("memo-recovered"));
    expect(memoizedEmbedModel(dir)?.modelId).toBe("memo-recovered");
  });
});

interface EmbedMock {
  url: string;
  calls: number; // count of POST /embed requests received
  close: () => Promise<void>;
}

// Minimal in-process embedding endpoint: answers every /embed POST with a
// throwaway vector and counts requests, so a test can prove the MCP server
// memoizes the corpus index (one POST for the whole corpus, however many
// searches follow) instead of re-embedding it on every `search` call.
async function startEmbedMock(): Promise<EmbedMock> {
  const mock: EmbedMock = { url: "", calls: 0, close: async () => {} };
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/embed") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        mock.calls++;
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { texts: string[] };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ vectors: body.texts.map(() => [1, 0]) }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  mock.url = `http://127.0.0.1:${port}`;
  mock.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return mock;
}

// A staged MCP session: unlike mcpSession (fires all requests up front, one
// shot), this awaits each response before sending the next — so a test can
// mutate the repo on disk BETWEEN two tool calls against the SAME long-lived
// server process, which is exactly the scenario memoization must invalidate.
// It performs the MCP handshake on spawn (issue #12), mirroring what
// mcpSession callers send: initialize + notifications/initialized, with every
// call() gated on the initialize response.
function mcpStagedSession(env: Record<string, string | undefined>): {
  call: (id: number, name: string, args: Record<string, unknown>) => Promise<RpcMsg>;
  close: () => void;
} {
  const child = spawn(process.execPath, [CLI, "mcp"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });
  const waiters = new Map<number, (msg: RpcMsg) => void>();
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as RpcMsg;
      if (typeof msg.id === "number") {
        const waiter = waiters.get(msg.id);
        if (waiter) {
          waiters.delete(msg.id);
          waiter(msg);
        }
      }
    }
  });
  const send = (msg: Record<string, unknown>) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  // Handshake up front. id 0 is collision-free: staged-suite call ids start
  // at 1. call() awaits the id-0 response, so the first tool call can only
  // resolve against an initialized server.
  const ready = new Promise<void>((resolve) => {
    waiters.set(0, () => resolve());
  });
  send({ id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
  send({ method: "notifications/initialized" });
  return {
    call: async (id, name, args) => {
      await ready;
      return new Promise<RpcMsg>((resolve) => {
        waiters.set(id, resolve);
        send({ id, method: "tools/call", params: { name, arguments: args } });
      });
    },
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}

describe("MCP search — embedding index memoization (endpoint tier)", () => {
  let mock: EmbedMock | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  it("two successive semantic searches on unchanged repo state build the corpus index once", async () => {
    mock = await startEmbedMock();
    const session = mcpStagedSession({ CODEINDEX_EMBED_ENDPOINT: mock.url, CODEINDEX_EMBED_DIR: undefined });
    try {
      const first = await session.call(1, "search", { repo: REPO, query: "http client retry", semantic: true });
      const firstBody = JSON.parse(first.result!.content![0]!.text) as { tier: string };
      expect(firstBody.tier).toBe("endpoint");
      const callsAfterFirst = mock.calls; // 1 corpus-build POST + 1 query POST

      const second = await session.call(2, "search", { repo: REPO, query: "auth token", semantic: true });
      const secondBody = JSON.parse(second.result!.content![0]!.text) as { tier: string };
      expect(secondBody.tier).toBe("endpoint");

      // Same repo state → the corpus index is memoized: only the (per-query)
      // encode call happens again, not a whole new corpus build.
      expect(mock.calls).toBe(callsAfterFirst + 1);
    } finally {
      session.close();
    }
  }, 20_000);

  it("editing a file between searches invalidates the cache and rebuilds the corpus index", async () => {
    const tmpRepo = join(mkdtempSync(join(tmpdir(), "ci-mcp-memo-")), "mini-repo");
    cpSync(REPO, tmpRepo, { recursive: true });
    mock = await startEmbedMock();
    const session = mcpStagedSession({ CODEINDEX_EMBED_ENDPOINT: mock.url, CODEINDEX_EMBED_DIR: undefined });
    try {
      const first = await session.call(1, "search", { repo: tmpRepo, query: "http client retry", semantic: true });
      expect((JSON.parse(first.result!.content![0]!.text) as { tier: string }).tier).toBe("endpoint");
      const callsAfterFirst = mock.calls;

      // Mutate a source file → its content hash (and so the scan fingerprint)
      // changes; a plain comment append doesn't touch extracted symbols/summary,
      // isolating "the corpus rebuilt" from "the corpus text happened to differ".
      const clientFile = join(tmpRepo, "src", "client.ts");
      writeFileSync(clientFile, readFileSync(clientFile, "utf8") + "\n// touched\n");

      const second = await session.call(2, "search", { repo: tmpRepo, query: "http client retry", semantic: true });
      expect((JSON.parse(second.result!.content![0]!.text) as { tier: string }).tier).toBe("endpoint");

      // A rebuild happened: a fresh corpus-build POST AND a fresh query POST,
      // not just the one query POST a cache hit would cost.
      expect(mock.calls).toBe(callsAfterFirst + 2);
    } finally {
      session.close();
    }
  }, 20_000);
});

// --- T6: session-level scan + artifacts memoization --------------------------

// A private copy of the fixture per test: the session cache is a single entry
// keyed by (repo, opts), so a fresh tmp path guarantees a fresh entry.
function tmpFixtureCopy(prefix: string): string {
  const repo = join(mkdtempSync(join(tmpdir(), prefix)), "mini-repo");
  cpSync(REPO, repo, { recursive: true });
  return repo;
}

// A `git -C dir` runner with a fixed author/committer identity so `commit`
// works in any CI environment (no reliance on a global user.name/user.email).
function gitIn(dir: string): (...args: string[]) => void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  return (...args: string[]) => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env });
  };
}

describe("getScan (session-level single-entry scan cache)", () => {
  it("returns the SAME RepoScan object across two calls on an unchanged repo", () => {
    const repo = tmpFixtureCopy("ci-scan-memo-");
    const s1 = getScan(repo, {});
    const s2 = getScan(repo, {});
    expect(s2).toBe(s1); // object identity — keeps the derived-structure WeakMap warm
  });

  it("a content edit between calls yields a NEW scan object reflecting the edit", () => {
    const repo = tmpFixtureCopy("ci-scan-memo-");
    const s1 = getScan(repo, {});
    const target = join(repo, "src", "client.ts");
    writeFileSync(target, readFileSync(target, "utf8") + "\n// touched\n");
    const s2 = getScan(repo, {});
    expect(s2).not.toBe(s1);
    const before = s1.files.find((f) => f.rel === "src/client.ts")!;
    const after = s2.files.find((f) => f.rel === "src/client.ts")!;
    expect(after.hash).not.toBe(before.hash);
  });

  it("an mtime-only touch (content unchanged) still returns the OLD scan object", () => {
    const repo = tmpFixtureCopy("ci-scan-memo-");
    const s1 = getScan(repo, {});
    // Bump mtime without changing a byte: the stat fastpath misses, the exact
    // content hash then PROVES the content unchanged — same object comes back.
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(repo, "src", "client.ts"), past, past);
    const s2 = getScan(repo, {});
    expect(s2).toBe(s1);
  });

  it("different scan options on the same repo are a different session key", () => {
    const repo = tmpFixtureCopy("ci-scan-memo-");
    const all = getScan(repo, {});
    const scoped = getScan(repo, { scope: "src" });
    expect(scoped).not.toBe(all);
    expect(scoped.files.every((f) => f.rel.startsWith("src/"))).toBe(true);
  });

  it("a git HEAD move with an unchanged worktree refreshes `commit` yet keeps the SAME scan object", () => {
    const repo = tmpFixtureCopy("ci-scan-gitcommit-");
    const git = gitIn(repo);
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    const s1 = getScan(repo, {});
    const c1 = s1.commit;
    expect(c1).toBeTruthy();
    expect(c1).toBe(headCommit(repo)); // baseline: cache primed at C1

    // Move HEAD with an EMPTY commit: a new commit object over an IDENTICAL tree,
    // no worktree file rewritten — so the stat fastpath still matches every file
    // and the next scan is contentUnchanged. `commit` (headCommit) is NOT part of
    // that stat/hash oracle, so without the refresh the old C1 would leak out.
    git("commit", "-q", "--allow-empty", "-m", "two");
    const c2 = headCommit(repo);
    expect(c2).not.toBe(c1);

    const s2 = getScan(repo, {});
    expect(s2).toBe(s1); // object identity preserved — derived WeakMap/artifacts stay warm
    expect(s2.commit).toBe(c2); // ...but the stale commit is refreshed to what a cold scanRepo reports
  });
});

describe("toCacheMap", () => {
  it("re-expresses a scan as the ScanOptions.cache shape (rel → hash/record/size/mtimeMs)", () => {
    const repo = tmpFixtureCopy("ci-cachemap-");
    const scan = getScan(repo, {});
    const map = toCacheMap(scan);
    expect(map.size).toBe(scan.files.length);
    for (const f of scan.files) {
      const entry = map.get(f.rel)!;
      expect(entry.record).toBe(f); // the record itself, not a copy
      expect(entry.hash).toBe(f.hash);
      expect(entry.size).toBe(f.size);
      expect(entry.mtimeMs).toBe(scan.mtimes.get(f.rel));
    }
  });
});

describe("getArtifacts (lazy pipeline memoized on scan identity)", () => {
  it("reuses the artifacts across calls and renders byte-identically to a fresh build on a pristine copy", () => {
    const repo = tmpFixtureCopy("ci-arts-memo-");
    const pristine = tmpFixtureCopy("ci-arts-fresh-");
    const a1 = getArtifacts(repo, {});
    const a2 = getArtifacts(repo, {});
    expect(a2).toBe(a1); // same IndexArtifacts object — pipeline ran once
    expect(a2.graph).toBe(a1.graph);
    // The memoized graph renders byte-equal to a from-scratch buildIndexArtifacts
    // on a pristine copy of the same tree (neither copy is a git repo, so the
    // graphs carry no commit) — the cache changes cost, never bytes.
    expect(renderGraphJson(a2.graph)).toBe(renderGraphJson(buildIndexArtifacts(pristine).graph));
  });

  it("a content edit drops the memoized artifacts along with the scan", () => {
    const repo = tmpFixtureCopy("ci-arts-memo-");
    const a1 = getArtifacts(repo, {});
    const target = join(repo, "src", "util.ts");
    writeFileSync(target, readFileSync(target, "utf8") + "\nexport function extraHelper(): number {\n  return 7;\n}\n");
    const a2 = getArtifacts(repo, {});
    expect(a2).not.toBe(a1);
    expect(JSON.stringify(a2.symbols.defs)).toContain("extraHelper");
  });
});

describe("MCP session cache — e2e over one long-lived server", () => {
  it("a successful edit tool call invalidates the cache: symbols_overview reflects the edit", async () => {
    const repo = tmpFixtureCopy("ci-mcp-sess-");
    const session = mcpStagedSession({});
    try {
      const before = await session.call(1, "symbols_overview", { repo, file: "src/util.ts" });
      expect(before.result!.isError).toBeUndefined();
      expect(before.result!.content![0]!.text).toContain("backoff");

      const edit = await session.call(2, "replace_symbol_body", {
        repo,
        namePath: "backoff",
        file: "src/util.ts",
        body: "export function backoffTweaked(attempt: number): number {\n  return Math.min(2000, 3 ** attempt);\n}",
      });
      expect(edit.result!.isError).toBeUndefined();

      // The pre-edit call primed the session cache against this exact repo —
      // a stale cache would still show the old symbol here.
      const after = await session.call(3, "symbols_overview", { repo, file: "src/util.ts" });
      expect(after.result!.isError).toBeUndefined();
      expect(after.result!.content![0]!.text).toContain("backoffTweaked");
    } finally {
      session.close();
    }
  }, 20_000);

  it("two graph calls on an unchanged repo return byte-identical text", async () => {
    const session = mcpStagedSession({});
    try {
      const g1 = await session.call(1, "graph", { repo: REPO });
      const g2 = await session.call(2, "graph", { repo: REPO });
      expect(g1.result!.isError).toBeUndefined();
      const text1 = g1.result!.content![0]!.text;
      expect(text1).toContain('"schemaVersion"');
      expect(g2.result!.content![0]!.text).toBe(text1); // second render from memoized artifacts
    } finally {
      session.close();
    }
  }, 20_000);

  it("warms a language whose first file appears mid-session — no regex-tier divergence from a cold build", async () => {
    // A brand-new repo seen as TS-only at first touch: graph#1 warms ONLY the
    // typescript grammar; `go` is never loaded in this child process until a .go
    // file appears. The session cache (getScan) is explicitly built to pick up
    // mid-session file adds, so the grammar warm MUST re-derive per call — a memo
    // frozen on the repo path would leave `go` unloaded and route the new file to
    // the regex tier, diverging from a cold build on the identical on-disk state.
    const repo = mkdtempSync(join(tmpdir(), "ci-mcp-lazygrammar-"));
    writeFileSync(join(repo, "app.ts"), "export function app(): number {\n  return 1;\n}\n");

    const session = mcpStagedSession({});
    try {
      const g1 = await session.call(1, "graph", { repo });
      expect(g1.result!.isError).toBeUndefined();

      // Add a Go file mid-session. `const` has NO rule in the go regex tier
      // (src/lang/go.ts) and a struct type is kinded "type" by the AST but
      // "struct" by regex, so the two tiers produce different symbols for it.
      writeFileSync(
        join(repo, "srv.go"),
        "package srv\n\nconst MaxConns = 100\n\ntype Server struct {\n\taddr string\n}\n\nfunc (s *Server) Handle() error {\n\treturn nil\n}\n\nfunc NewServer(addr string) *Server {\n\treturn &Server{addr: addr}\n}\n",
      );

      // symbols_overview shows the mechanism directly: only the AST tier emits the
      // `const MaxConns` symbol, so its presence proves `go` was warmed on THIS
      // call — i.e. the warm re-derived the grammar set after the file appeared.
      const ov = await session.call(2, "symbols_overview", { repo, file: "srv.go" });
      expect(ov.result!.isError).toBeUndefined();
      expect(ov.result!.content![0]!.text).toContain("MaxConns");

      // The headline guarantee: the mid-session graph is byte-identical to what a
      // cold process renders on the SAME on-disk state (this test process has every
      // grammar warmed via tests/setup.ts, so buildIndexArtifacts extracts srv.go
      // via AST — the correct tier). A frozen per-repo-path warm would render
      // srv.go via regex and break these bytes.
      const g2 = await session.call(3, "graph", { repo });
      expect(g2.result!.isError).toBeUndefined();
      expect(g2.result!.content![0]!.text).toBe(renderGraphJson(buildIndexArtifacts(repo).graph));
    } finally {
      session.close();
    }
  }, 20_000);

  it("scan_summary reports the CURRENT HEAD after a git commit moves it, not the primed one", async () => {
    const repo = tmpFixtureCopy("ci-mcp-scancommit-");
    const git = gitIn(repo);
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    const session = mcpStagedSession({});
    try {
      // First call primes the session cache against this repo at commit C1.
      const r1 = await session.call(1, "scan_summary", { repo });
      expect(r1.result!.isError).toBeUndefined();
      const c1 = (JSON.parse(r1.result!.content![0]!.text) as { commit?: string }).commit;
      expect(c1).toBe(headCommit(repo));

      // Move HEAD with an empty commit — identical tree, untouched worktree — so
      // the freshness oracle proves the content unchanged and the SAME cached
      // scan comes back. A stale-commit read would still report C1 here.
      git("commit", "-q", "--allow-empty", "-m", "two");
      const c2 = headCommit(repo);
      expect(c2).not.toBe(c1);

      const r2 = await session.call(2, "scan_summary", { repo });
      expect(r2.result!.isError).toBeUndefined();
      const reported = (JSON.parse(r2.result!.content![0]!.text) as { commit?: string }).commit;
      expect(reported).toBe(c2); // == what a cold process would report on identical on-disk state
    } finally {
      session.close();
    }
  }, 20_000);
});

describe("runMcpServer serverInfo override", () => {
  // Spawn the BUNDLE through a tiny launcher that passes opts — the same way a
  // downstream consumer embeds the server under its own identity.
  function writeLauncher(opts: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ci-mcp-serverinfo-"));
    const launcher = join(dir, "launch.mjs");
    writeFileSync(
      launcher,
      `import { runMcpServer } from ${JSON.stringify(pathToFileURL(ENGINE).href)};\nawait runMcpServer(${opts});\n`,
    );
    return launcher;
  }
  const initialize = { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } };

  it("announces the overridden name and version in the initialize response", async () => {
    const launcher = writeLauncher(`{ serverInfo: { name: "embedded-index", version: "9.9.9" } }`);
    const res = await mcpSession([initialize], undefined, [launcher]);
    expect(res.get(1)!.result!.serverInfo).toEqual({ name: "embedded-index", version: "9.9.9" });
  }, 20_000);

  it("a partial override keeps the defaults for omitted fields", async () => {
    const launcher = writeLauncher(`{ serverInfo: { name: "only-name" } }`);
    const res = await mcpSession([initialize], undefined, [launcher]);
    expect(res.get(1)!.result!.serverInfo!.name).toBe("only-name");
    // Version falls back to the engine's own — mirror what the bundle reports.
    const { ENGINE_VERSION } = (await import("../src/types.js")) as { ENGINE_VERSION: string };
    expect(res.get(1)!.result!.serverInfo!.version).toBe(ENGINE_VERSION);
  }, 20_000);
});

// --- T7: MCP persisted-index preload -----------------------------------------

// Write a real .codeindex/ index into `repo` exactly as `codeindex index` does,
// so the MCP server finds cache.json + graph.json + symbols.json on first touch.
// The spawned engine resolves the same bundle-adjacent grammars the MCP server
// and the in-process buildIndexArtifacts use, so extraction tiers match.
function primeIndex(repo: string): void {
  execFileSync(process.execPath, [CLI, "index", "--out", join(repo, ".codeindex"), "--repo", repo], { stdio: "pipe" });
}

describe("MCP persisted-index preload (session seeding from .codeindex)", () => {
  it("seeds the session scan + artifacts from a primed .codeindex — byte-equal to a fresh build", () => {
    const repo = tmpFixtureCopy("ci-preload-");
    const pristine = tmpFixtureCopy("ci-preload-fresh-");
    primeIndex(repo);
    // The scan seeded from cache.json proves content-unchanged (a cold scan with
    // no cache is contentUnchanged:false) — i.e. the persisted cache was loaded.
    const scan = getScan(repo, {});
    expect(scan.contentUnchanged).toBe(true);
    // The artifacts come from graph.json/symbols.json, yet render byte-identically
    // to a from-scratch buildIndexArtifacts on a pristine copy (neither tmp copy
    // is a git repo, so both carry no commit) — the preload changes cost, never bytes.
    const arts = getArtifacts(repo, {});
    const fresh = buildIndexArtifacts(pristine);
    expect(renderGraphJson(arts.graph)).toBe(renderGraphJson(fresh.graph));
    expect(renderSymbolsJson(arts.symbols)).toBe(renderSymbolsJson(fresh.symbols));
  });

  it("a content edit after priming invalidates the preload — the response reflects the edit", () => {
    const repo = tmpFixtureCopy("ci-preload-edit-");
    primeIndex(repo);
    // Append a new export AFTER priming: the file grows (stat fastpath misses on
    // size), the hash then differs, so the scan is no longer content-unchanged and
    // the persisted artifacts are NOT preloaded — a fresh build reflects the edit.
    const target = join(repo, "src", "util.ts");
    writeFileSync(target, readFileSync(target, "utf8") + "\nexport function extraHelperXYZ(): number {\n  return 7;\n}\n");
    const scan = getScan(repo, {});
    expect(scan.contentUnchanged).toBe(false);
    const arts = getArtifacts(repo, {});
    expect(JSON.stringify(arts.symbols.defs)).toContain("extraHelperXYZ");
  });

  it("a corrupt/partial .codeindex/graph.json falls back to a fresh build without throwing", () => {
    const repo = tmpFixtureCopy("ci-preload-corrupt-");
    const pristine = tmpFixtureCopy("ci-preload-corrupt-fresh-");
    primeIndex(repo);
    // Garble graph.json so its sha no longer matches cache.json's meta. The guard
    // rejects the artifact preload; the scan is still seeded (content-unchanged),
    // and the artifacts rebuild fresh — byte-identical, no throw.
    writeFileSync(join(repo, ".codeindex", "graph.json"), "{ not valid json");
    const arts = getArtifacts(repo, {}); // must not throw
    expect(renderGraphJson(arts.graph)).toBe(renderGraphJson(buildIndexArtifacts(pristine).graph));
  });

  it("a symbols.json deleted since cache.json was written falls back without throwing", () => {
    const repo = tmpFixtureCopy("ci-preload-missing-");
    const pristine = tmpFixtureCopy("ci-preload-missing-fresh-");
    primeIndex(repo);
    rmSync(join(repo, ".codeindex", "symbols.json"));
    const arts = getArtifacts(repo, {}); // readFileSync throws internally → caught → rebuild
    expect(renderSymbolsJson(arts.symbols)).toBe(renderSymbolsJson(buildIndexArtifacts(pristine).symbols));
  });

  it("graph/symbols deserialization round-trips byte-for-byte (render → parse → render)", () => {
    const { graph, symbols } = buildIndexArtifacts(REPO);
    const graphJson = renderGraphJson(graph);
    expect(renderGraphJson(JSON.parse(graphJson) as Graph)).toBe(graphJson);
    const symbolsJson = renderSymbolsJson(symbols);
    const parsedSymbols = JSON.parse(symbolsJson) as SymbolIndex;
    expect(renderSymbolsJson(parsedSymbols)).toBe(symbolsJson);
    // The `symbols` tool renders WITHOUT the trailing newline; that render must
    // round-trip too, since a preloaded (parsed) index feeds this exact call.
    expect(JSON.stringify(parsedSymbols, null, 2)).toBe(JSON.stringify(symbols, null, 2));

    // Adversarial POJO covering the losslessness edge cases the blueprint calls
    // out: an integer-like symbol name (V8 hoists numeric keys — must hoist
    // identically after a parse), and every optional field present vs absent.
    const synthetic: SymbolIndex = {
      schemaVersion: symbols.schemaVersion,
      defs: {
        "123": [{ file: "a.ts", line: 1, kind: "const", exported: true, lang: "typescript" }],
        Zeta: [{ file: "z.ts", line: 9, endLine: 12, kind: "method", exported: false, lang: "typescript", parent: "Z" }],
        alpha: [{ file: "b.ts", line: 3, kind: "function", exported: true, lang: "typescript" }],
      },
      refs: { "123": ["b.ts"], alpha: ["a.ts", "z.ts"] },
    };
    const synthJson = renderSymbolsJson(synthetic);
    expect(renderSymbolsJson(JSON.parse(synthJson) as SymbolIndex)).toBe(synthJson);
  });
});

describe("MCP persisted-index preload — e2e byte-identity across servers", () => {
  it("graph/symbols/find_symbol from a primed server are byte-equal to a cold server", async () => {
    const primed = tmpFixtureCopy("ci-preload-e2e-primed-");
    const cold = tmpFixtureCopy("ci-preload-e2e-cold-");
    primeIndex(primed); // cold gets no .codeindex/ → build-on-demand path
    const drive = (repo: string) =>
      mcpSession([
        { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
        { method: "notifications/initialized" },
        { id: 2, method: "tools/call", params: { name: "graph", arguments: { repo } } },
        { id: 3, method: "tools/call", params: { name: "symbols", arguments: { repo } } },
        { id: 4, method: "tools/call", params: { name: "find_symbol", arguments: { repo, namePath: "backoff" } } },
        { id: 5, method: "tools/call", params: { name: "mermaid", arguments: { repo } } },
      ]);
    const [p, c] = await Promise.all([drive(primed), drive(cold)]);
    for (const id of [2, 3, 4, 5]) {
      expect(p.get(id)!.result!.isError).toBeUndefined();
      expect(p.get(id)!.result!.content![0]!.text).toBe(c.get(id)!.result!.content![0]!.text);
    }
  }, 30_000);
});
