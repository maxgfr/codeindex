import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEndpointIndex,
  embedEndpointUrl,
  embedViaEndpoint,
  encodeQueryViaEndpoint,
  healthzUrl,
  probeEndpoint,
  resolveEmbedEndpoint,
} from "../src/embed/endpoint.js";
import { quantize } from "../src/embed/encode.js";
import { searchSemantic } from "../src/embed/search.js";
import { scanRepo } from "../src/scan.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const MODEL_DIR = fileURLToPath(new URL("./fixtures/embed-model", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

// A deterministic keyword-presence "embedding" so tests control the vectors
// without a real model: dim === KEYS.length, one float per keyword present.
const KEYS = ["auth", "http", "invoice", "token", "retry", "client", "backoff", "service"];
function embedText(t: string): number[] {
  const low = t.toLowerCase();
  return KEYS.map((k) => (low.includes(k) ? 1 : 0));
}

interface Mock {
  url: string;
  close: () => Promise<void>;
  embedCalls: number;
}

// Spin up an in-process HTTP embedding server implementing the v2.11 protocol
// (POST /embed {texts}->{vectors}, GET /healthz). `override` lets a test bend a
// single behavior (bad status, malformed body, hang) to probe degradation.
async function startMock(
  override?: (req: http.IncomingMessage, res: http.ServerResponse, texts: string[]) => boolean,
): Promise<Mock> {
  const mock: Mock = { url: "", close: async () => {}, embedCalls: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, model: "mock-mini" }));
      return;
    }
    if (req.method === "POST" && req.url === "/embed") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { texts: string[] };
        mock.embedCalls++;
        if (override && override(req, res, body.texts)) return; // test handled it
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ vectors: body.texts.map(embedText) }));
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

// A URL that is guaranteed to refuse connections: bind a port, then free it.
async function deadUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

const openMocks: Mock[] = [];
afterEach(async () => {
  while (openMocks.length) await openMocks.pop()!.close();
});
async function mock(
  override?: (req: http.IncomingMessage, res: http.ServerResponse, texts: string[]) => boolean,
): Promise<Mock> {
  const m = await startMock(override);
  openMocks.push(m);
  return m;
}

describe("endpoint client — protocol contract", () => {
  it("resolveEmbedEndpoint reads opts.url then CODEINDEX_EMBED_ENDPOINT, trimming, else undefined", () => {
    expect(resolveEmbedEndpoint({ url: "  http://x:1  " })).toBe("http://x:1");
    const prev = process.env.CODEINDEX_EMBED_ENDPOINT;
    delete process.env.CODEINDEX_EMBED_ENDPOINT;
    try {
      expect(resolveEmbedEndpoint()).toBeUndefined();
      process.env.CODEINDEX_EMBED_ENDPOINT = "http://env:2";
      expect(resolveEmbedEndpoint()).toBe("http://env:2");
    } finally {
      if (prev === undefined) delete process.env.CODEINDEX_EMBED_ENDPOINT;
      else process.env.CODEINDEX_EMBED_ENDPOINT = prev;
    }
  });

  it("derives /embed and /healthz from a base URL (idempotent when /embed is already present)", () => {
    expect(embedEndpointUrl("http://h:8756")).toBe("http://h:8756/embed");
    expect(embedEndpointUrl("http://h:8756/")).toBe("http://h:8756/embed");
    expect(embedEndpointUrl("http://h:8756/embed")).toBe("http://h:8756/embed");
    expect(healthzUrl("http://h:8756")).toBe("http://h:8756/healthz");
    expect(healthzUrl("http://h:8756/embed")).toBe("http://h:8756/healthz");
  });

  it("POSTs {texts} to /embed and parses {vectors}", async () => {
    const m = await mock();
    const vecs = await embedViaEndpoint(["auth token", "http client"], { url: m.url });
    expect(vecs).toEqual([embedText("auth token"), embedText("http client")]);
    expect(m.embedCalls).toBe(1);
  });

  it("throws with no endpoint configured", async () => {
    await expect(embedViaEndpoint(["x"], { url: "" })).rejects.toThrow(/no embedding endpoint/i);
  });

  it("throws a clear error on a non-200 status", async () => {
    const m = await mock((_req, res) => {
      res.writeHead(500);
      res.end("boom");
      return true;
    });
    await expect(embedViaEndpoint(["x"], { url: m.url })).rejects.toThrow(/HTTP 500/);
  });

  it("throws on a malformed { vectors } payload", async () => {
    const m = await mock((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ nope: 1 }));
      return true;
    });
    await expect(embedViaEndpoint(["x"], { url: m.url })).rejects.toThrow(/malformed/);
  });

  it("aborts on timeout", async () => {
    const m = await mock((_req, _res) => true /* never responds */);
    await expect(embedViaEndpoint(["x"], { url: m.url, timeoutMs: 150 })).rejects.toThrow();
  });
});

describe("endpoint tier — same quantize pipeline as the static tier", () => {
  it("encodeQueryViaEndpoint quantizes the float vector identically to encode.ts quantize()", async () => {
    const m = await mock();
    const q = await encodeQueryViaEndpoint("auth token", { url: m.url });
    // The endpoint float vector run through the SHARED L2+int8 pipeline.
    expect([...q]).toEqual([...quantize(embedText("auth token"))]);
  });

  it("buildEndpointIndex embeds the corpus and yields an int8 index searchSemantic can rank", async () => {
    const m = await mock();
    const scan = scanRepo(REPO);
    const index = await buildEndpointIndex(scan, { url: m.url });
    expect(index.records.length).toBeGreaterThan(0);
    expect(index.dim).toBe(KEYS.length);
    // every record vec is int8 of the right dim
    expect(index.records.every((r) => r.vec.length === KEYS.length)).toBe(true);

    const qvec = await encodeQueryViaEndpoint("http client retry", { url: m.url });
    const a = searchSemantic(scan, "http client retry", index, { queryVec: qvec });
    const b = searchSemantic(scan, "http client retry", index, { queryVec: qvec });
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // deterministic given a fixed index
    expect(a[0]!.file).toBe("src/client.ts");
  });
});

describe("probeEndpoint", () => {
  it("returns true when /healthz answers 200, false when the endpoint is down", async () => {
    const m = await mock();
    expect(await probeEndpoint(m.url)).toBe(true);
    const dead = await deadUrl();
    expect(await probeEndpoint(dead)).toBe(false);
  });
});

describe("CLI wiring — endpoint precedence, success and degradation (exit 0)", () => {
  // Async subprocess (NOT spawnSync): the mock server shares this process's
  // event loop, so a synchronous spawn would deadlock the server for the child.
  const run = async (args: string[], env: Record<string, string | undefined>) => {
    try {
      const { stdout, stderr } = await pExecFile(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      return { stdout, stderr, status: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", status: err.code ?? 1 };
    }
  };

  it("`search --semantic` via a live endpoint returns non-empty results, exit 0", async () => {
    const m = await mock();
    const { stdout, status } = await run(["search", "http client retry", "--repo", REPO, "--semantic"], {
      CODEINDEX_EMBED_ENDPOINT: m.url,
      CODEINDEX_EMBED_DIR: undefined,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { file: string; semanticSymbol?: string }[];
    expect(parsed.length).toBeGreaterThan(0);
    // the endpoint tier attributed a semantic symbol to at least one file
    expect(parsed.some((r) => r.semanticSymbol !== undefined)).toBe(true);
  });

  it("endpoint takes PRECEDENCE over a present static model (embed status reports mode endpoint)", async () => {
    const m = await mock();
    const { stdout, status } = await run(["embed", "status", "--repo", REPO], {
      CODEINDEX_EMBED_ENDPOINT: m.url,
      CODEINDEX_EMBED_DIR: MODEL_DIR, // a model IS present…
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { mode: string; endpointReachable?: boolean };
    expect(parsed.mode).toBe("endpoint"); // …but the endpoint wins (explicit intent)
    expect(parsed.endpointReachable).toBe(true);
  });

  it("endpoint defined but UNREACHABLE → lexical fallback + stderr note, exit 0", async () => {
    const dead = await deadUrl();
    const { stdout, stderr, status } = await run(["search", "http client retry", "--repo", REPO, "--semantic"], {
      CODEINDEX_EMBED_ENDPOINT: dead,
      CODEINDEX_EMBED_DIR: undefined,
    });
    expect(status).toBe(0);
    expect(stderr).toMatch(/endpoint/i);
    const parsed = JSON.parse(stdout) as { semanticSymbol?: string }[];
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((r) => r.semanticSymbol === undefined)).toBe(true); // pure lexical
  });

  it("`embed status` reports endpointReachable=false when the endpoint is down", async () => {
    const dead = await deadUrl();
    const { stdout } = await run(["embed", "status", "--repo", REPO], {
      CODEINDEX_EMBED_ENDPOINT: dead,
      CODEINDEX_EMBED_DIR: undefined,
    });
    const parsed = JSON.parse(stdout) as { mode: string; endpointReachable?: boolean };
    expect(parsed.mode).toBe("endpoint");
    expect(parsed.endpointReachable).toBe(false);
  });
});

describe("`embed serve` convenience (engine-cli only, never the library)", () => {
  const run = (args: string[]) => {
    try {
      const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
      return { stdout, status: 0 };
    } catch (e) {
      const err = e as { stdout?: string; status?: number };
      return { stdout: err.stdout ?? "", status: err.status ?? 1 };
    }
  };
  it("prints the docker run one-liner for the embed image (default, no --run)", () => {
    const { stdout, status } = run(["embed", "serve"]);
    expect(status).toBe(0);
    expect(stdout).toContain("ghcr.io/maxgfr/codeindex-embed");
    expect(stdout).toContain("8756");
  });
});
