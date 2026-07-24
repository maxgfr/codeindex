import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { memoizedEmbeddingIndex, memoizedEmbedModel, scanFingerprint } from "../src/mcp.js";
import type { RepoScan } from "../src/scan.js";
import type { FileRecord } from "../src/types.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const MODEL_DIR = fileURLToPath(new URL("./fixtures/embed-model", import.meta.url));

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
// `env` overrides/extends the child's environment (e.g. CODEINDEX_EMBED_DIR
// to exercise the static embedding tier) on top of the parent's process.env.
function mcpSession(
  requests: Record<string, unknown>[],
  env?: Record<string, string | undefined>,
): Promise<Map<number, RpcMsg>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, "mcp"], {
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
  return { root: "/repo", files, languages: {}, docText: new Map(), mtimes: new Map(), capped: false, excluded: 0 };
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
