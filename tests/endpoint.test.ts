import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);
import { afterEach, describe, expect, it } from "vitest";
import {
  EMBED_IMAGE_VERSION,
  ENDPOINT_MAX_TEXT_CHARS,
  buildEndpointIndex,
  embedEndpointUrl,
  embedViaEndpoint,
  encodeQueryViaEndpoint,
  endpointModelId,
  healthzUrl,
  probeEndpoint,
  resolveEmbedEndpoint,
} from "../src/embed/endpoint.js";
import { quantize } from "../src/embed/encode.js";
import { embeddingUnits } from "../src/embed/index.js";
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
  texts: string[][]; // each POST's texts, in arrival order
}

// Spin up an in-process HTTP embedding server implementing the v2.11 protocol
// (POST /embed {texts}->{vectors}, GET /healthz). `override` lets a test bend a
// single behavior (bad status, malformed body, hang) to probe degradation.
async function startMock(
  override?: (req: http.IncomingMessage, res: http.ServerResponse, texts: string[]) => boolean,
): Promise<Mock> {
  const mock: Mock = { url: "", close: async () => {}, embedCalls: 0, texts: [] };
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
        mock.texts.push(body.texts);
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

// The reference server's own limits (docker/embed/server.mjs): a text past
// MAX_TEXT_CHARS is answered 400.
const SERVER_MAX_TEXT_CHARS = 8192;
const refusingLongTexts = (_req: http.IncomingMessage, res: http.ServerResponse, texts: string[]): boolean => {
  if (!texts.some((t) => t.length > SERVER_MAX_TEXT_CHARS)) return false;
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `each text must be at most ${SERVER_MAX_TEXT_CHARS} characters` }));
  return true;
};

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

  it("throws on vectors of different dimensions, or holding a non-finite value", async () => {
    const answer = (vectors: unknown) => async () =>
      mock((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ vectors }));
        return true;
      });
    const ragged = await (await answer([[1, 0], [1, 0, 0]]))();
    await expect(embedViaEndpoint(["a", "b"], { url: ragged.url })).rejects.toThrow(/different dimensions/);
    // JSON has no NaN; a null in a row is the same defect.
    const holes = await (await answer([[1, null]]))();
    await expect(embedViaEndpoint(["a"], { url: holes.url })).rejects.toThrow(/malformed/);
  });

  it("refuses a response past what it reads into memory", async () => {
    const m = await mock((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": String(65 * 1024 * 1024) });
      res.end();
      return true;
    });
    await expect(embedViaEndpoint(["x"], { url: m.url })).rejects.toThrow(/past the 67108864 accepted/);
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

describe("endpoint tier — reuse and parallel batches", () => {
  it("previous donates every vector whose unit text is unchanged; only new texts are sent", async () => {
    const m = await mock();
    const scan = scanRepo(REPO);
    const first = await buildEndpointIndex(scan, { url: m.url });
    const sent = m.texts.flat().length;
    expect(sent).toBe(new Set(first.records.map((r) => r.textHash)).size); // one POST per distinct text

    const again = await buildEndpointIndex(scan, { url: m.url, previous: first });
    expect(m.texts.flat().length).toBe(sent); // nothing re-sent
    expect(again).toEqual(first);

    // A different model id (another model behind the URL) shares nothing.
    await buildEndpointIndex(scan, { url: m.url, previous: first, modelId: "endpoint@other" });
    expect(m.texts.flat().length).toBe(2 * sent);
  });

  it("batches in flight at once still land in corpus order", async () => {
    // Answer later batches FIRST: the index must not depend on arrival order.
    let n = 0;
    const m = await mock((_req, res, texts) => {
      const delay = 40 - 10 * n++;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ vectors: texts.map(embedText) }));
      }, Math.max(delay, 0));
      return true;
    });
    const scan = scanRepo(REPO);
    const serial = await buildEndpointIndex(scan, { url: (await mock()).url, batchSize: 3, concurrency: 1 });
    const parallel = await buildEndpointIndex(scan, { url: m.url, batchSize: 3, concurrency: 4 });
    expect(m.embedCalls).toBeGreaterThan(3);
    expect(parallel).toEqual(serial);
  });

  it("one failed batch fails the build, and the remaining batches are not sent", async () => {
    const m = await mock((_req, res) => {
      res.writeHead(500);
      res.end();
      return true;
    });
    const scan = scanRepo(REPO);
    await expect(buildEndpointIndex(scan, { url: m.url, batchSize: 1, concurrency: 2 })).rejects.toThrow(/HTTP 500/);
    await new Promise((r) => setTimeout(r, 50)); // let a request still in flight arrive
    expect(scan.files.length).toBeGreaterThan(4);
    expect(m.embedCalls).toBeLessThanOrEqual(2);
  });

  it("endpointModelId fingerprints the model behind the URL", async () => {
    const a = await endpointModelId({ url: (await mock()).url });
    expect(a).toMatch(/^endpoint@[0-9a-f]{16}$/);
    expect(await endpointModelId({ url: (await mock()).url })).toBe(a);
    const other = await mock((_req, res, texts) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ vectors: texts.map((t) => embedText(t).reverse()) }));
      return true;
    });
    expect(await endpointModelId({ url: other.url })).not.toBe(a);
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

  it("with an index present, `search --semantic` caches endpoint vectors beside it and re-sends only new texts", async () => {
    const repo = join(mkdtempSync(join(tmpdir(), "ci-endpoint-cache-")), "mini-repo");
    cpSync(REPO, repo, { recursive: true });
    try {
      const env = { CODEINDEX_EMBED_ENDPOINT: undefined, CODEINDEX_EMBED_DIR: undefined };
      let swapped = false; // flips the model behind the same URL
      const m = await mock((_req, res, texts) => {
        if (!swapped) return false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ vectors: texts.map((t) => embedText(t).reverse()) }));
        return true;
      });
      const q = ["search", "http client retry", "--repo", repo, "--semantic"];
      // No index yet: nothing is written into the repo.
      const bare = await run(q, { ...env, CODEINDEX_EMBED_ENDPOINT: m.url });
      expect(bare.status).toBe(0);
      expect(existsSync(join(repo, ".codeindex", "embed-cache"))).toBe(false);

      expect((await run(["index", "--repo", repo, "--out", join(repo, ".codeindex")], env)).status).toBe(0);
      const before = m.texts.length;
      const first = await run(q, { ...env, CODEINDEX_EMBED_ENDPOINT: m.url });
      expect(first.status).toBe(0);
      expect(readdirSync(join(repo, ".codeindex", "embed-cache"))).toEqual([expect.stringMatching(/^endpoint-[0-9a-f]{12}\.bin$/)]);
      const corpus = m.texts.slice(before).flat().length;

      const mark = m.texts.length;
      const second = await run(q, { ...env, CODEINDEX_EMBED_ENDPOINT: m.url });
      expect(second.stdout).toBe(first.stdout);
      // the fingerprint text and the query — no corpus text at all
      expect(m.texts.slice(mark).map((t) => t.length)).toEqual([1, 1]);
      expect(corpus).toBeGreaterThan(2);
      expect(m.texts.at(-1)).toEqual(["http client retry"]);
      expect(bare.stdout).toBe(first.stdout);

      // A different model behind the same URL misses the cache and re-sends
      // the whole corpus (plus the fingerprint text and the query).
      swapped = true;
      const mark2 = m.texts.length;
      expect((await run(q, { ...env, CODEINDEX_EMBED_ENDPOINT: m.url })).status).toBe(0);
      expect(m.texts.slice(mark2).flat().length).toBe(corpus);
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  });

  it("an ABSOLUTE --index keeps the endpoint cache in that index, not under the repo", async () => {
    const base = mkdtempSync(join(tmpdir(), "ci-endpoint-abs-"));
    const repo = join(base, "mini-repo");
    const idx = join(base, "idx"); // outside the repo
    cpSync(REPO, repo, { recursive: true });
    try {
      const env = { CODEINDEX_EMBED_ENDPOINT: undefined, CODEINDEX_EMBED_DIR: undefined };
      const m = await mock();
      expect((await run(["index", "--repo", repo, "--out", idx], env)).status).toBe(0);
      const res = await run(["search", "http client retry", "--repo", repo, "--semantic", "--index", idx], { ...env, CODEINDEX_EMBED_ENDPOINT: m.url });
      expect(res.status).toBe(0);
      expect(readdirSync(join(idx, "embed-cache"))).toEqual([expect.stringMatching(/^endpoint-[0-9a-f]{12}\.bin$/)]);
      expect(existsSync(join(repo, idx))).toBe(false); // no phantom <repo>/<abs path>
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
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

  it("publishes the unauthenticated server on the loopback interface, at the image's own version", () => {
    const { stdout } = run(["embed", "serve"]);
    const version = readFileSync(fileURLToPath(new URL("../docker/embed/VERSION", import.meta.url)), "utf8").trim();
    expect(EMBED_IMAGE_VERSION).toBe(version);
    expect(stdout.trim()).toBe(`docker run -d -p 127.0.0.1:8756:8756 ghcr.io/maxgfr/codeindex-embed:${version}`);
  });
});

describe("texts longer than the reference server accepts", () => {
  // A changelog of 1 500 releases: its file-level unit joins every heading.
  function repoWithLongChangelog(): string {
    const dir = mkdtempSync(join(tmpdir(), "ci-embed-long-"));
    const headings = Array.from({ length: 1500 }, (_, i) => `## Release ${i} about the http client retry\n\ntext\n`);
    writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n${headings.join("\n")}`);
    writeFileSync(join(dir, "auth.md"), "# Auth token service\n\nHow tokens are issued.\n");
    return dir;
  }

  it("the corpus unit of such a file is far past the limit", () => {
    const longest = Math.max(...embeddingUnits(scanRepo(repoWithLongChangelog())).map((u) => u.text.length));
    expect(longest).toBeGreaterThan(SERVER_MAX_TEXT_CHARS * 4);
  });

  it("are cut to the limit instead of failing the whole build", async () => {
    const m = await mock(refusingLongTexts);
    const scan = scanRepo(repoWithLongChangelog());
    const index = await buildEndpointIndex(scan, { url: m.url });
    expect(index.records.map((r) => r.file).sort()).toEqual(["CHANGELOG.md", "auth.md"]);
    const sent = m.texts.flat();
    expect(Math.max(...sent.map((t) => t.length))).toBe(ENDPOINT_MAX_TEXT_CHARS);
    // The record still carries the hash of the unit's whole text: reuse is unchanged.
    const again = await buildEndpointIndex(scan, { url: m.url, previous: index });
    expect(again.records).toEqual(index.records);
    expect(m.texts.flat()).toHaveLength(sent.length);
  });

  it("a query is cut the same way, and never in the middle of a surrogate pair", async () => {
    const m = await mock(refusingLongTexts);
    await encodeQueryViaEndpoint("x".repeat(ENDPOINT_MAX_TEXT_CHARS - 1) + "\u{1F600} tail", { url: m.url });
    const [sent] = m.texts.flat();
    expect(sent).toBe("x".repeat(ENDPOINT_MAX_TEXT_CHARS - 1));
  });
});
