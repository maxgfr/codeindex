// docker/embed/server.mjs without Docker or the real model: the server is
// copied next to a stub of @xenova/transformers and driven over HTTP.
// scripts/test-docker.mjs runs the real image; this covers the server's own
// logic on every run of the suite.
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SERVER = fileURLToPath(new URL("../docker/embed/server.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ci-embed-server-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const stub = join(dir, "node_modules", "@xenova", "transformers");
mkdirSync(stub, { recursive: true });
writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "@xenova/transformers", type: "module", main: "index.js" }));
// The first FAIL_LOADS model loads reject; an embedding takes SLOW_MS.
writeFileSync(
  join(stub, "index.js"),
  `export const env = {};
let failures = Number(process.env.FAIL_LOADS ?? 0);
export async function pipeline() {
  if (failures-- > 0) throw new Error("model cache not mounted: /secret/path");
  return async (texts) => {
    // BLOCK_MS: hold the event loop, as inference on the main thread does.
    const until = Date.now() + Number(process.env.BLOCK_MS ?? 0);
    while (Date.now() < until);
    await new Promise((r) => setTimeout(r, Number(process.env.SLOW_MS ?? 0)));
    return { tolist: () => texts.map(() => [1, 0]) };
  };
}
`,
);
copyFileSync(SERVER, join(dir, "server.mjs"));

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

async function withServer(env: Record<string, string>, fn: (s: { base: string; child: ChildProcess; stderr: () => string }) => Promise<void>) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, "server.mjs")], { env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (c) => (stderr += c));
  await new Promise((resolve) => child.stdout!.once("data", resolve));
  try {
    await fn({ base: `http://127.0.0.1:${port}`, child, stderr: () => stderr });
  } finally {
    child.kill("SIGKILL");
  }
}
const post = async (base: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + "/embed", { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A POST written over a raw socket: its headers and half its body now, the
// rest on finish(). `status` is the response's status code, or null if the
// connection closed without one.
function partialPost(port: number, body: string): Promise<{ socket: Socket; status: Promise<number | null>; finish: () => void }> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    let received = "";
    const status = new Promise<number | null>((done) => {
      socket.on("data", (c) => {
        received += c;
        const m = /^HTTP\/1\.1 (\d{3})/.exec(received);
        if (m) done(Number(m[1]));
      });
      socket.on("close", () => done(null));
    });
    const half = body.length >> 1;
    socket.once("connect", () => {
      socket.write(`POST /embed HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, half)}`);
      resolve({ socket, status, finish: () => socket.writable && socket.write(body.slice(half)) });
    });
  });
}

describe("the reference embedding server", () => {
  it("refuses a request from a web page, and serves a program's", async () => {
    await withServer({}, async ({ base }) => {
      expect((await post(base, { texts: ["a"] })).status).toBe(200);
      expect((await post(base, { texts: ["a"] }, { origin: "https://evil.example" })).status).toBe(403);
    });
  });

  it("retries a failed model load on the next request, and sends no internal detail", async () => {
    await withServer({ FAIL_LOADS: "1" }, async ({ base, stderr }) => {
      const first = await post(base, { texts: ["a"] });
      expect(first).toEqual({ status: 500, body: { error: "internal error" } });
      expect(stderr()).toMatch(/model cache not mounted/);
      expect((await post(base, { texts: ["a"] })).status).toBe(200);
      expect((await fetch(base + "/healthz")).status).toBe(200);
    });
  });

  // 24 requests whose bodies are all still arriving: a server that counts a
  // request only once its body is read admits every one of them.
  it("runs at most 8 requests at once, counting those whose body is still arriving", async () => {
    await withServer({ SLOW_MS: "200" }, async ({ base }) => {
      const port = Number(new URL(base).port);
      const body = JSON.stringify({ texts: ["a"] });
      const uploads = await Promise.all(Array.from({ length: 24 }, () => partialPost(port, body)));
      // The 16 over the bound are answered before their body is complete.
      const early = await Promise.all(uploads.map((u) => Promise.race([u.status, delay(1000).then(() => "pending")])));
      expect(early.filter((s) => s === 503)).toHaveLength(16);
      expect(early.filter((s) => s === "pending")).toHaveLength(8);
      for (const u of uploads) u.finish();
      const statuses = await Promise.all(uploads.map((u) => u.status));
      expect(statuses.filter((s) => s === 200)).toHaveLength(8);
      expect(statuses.filter((s) => s === 503)).toHaveLength(16);
      expect((await post(base, { texts: ["a"] })).status).toBe(200);
    });
  }, 30_000);

  it("gives a slot back when a body stalls, or its client leaves", async () => {
    await withServer({ BODY_TIMEOUT_MS: "500" }, async ({ base }) => {
      const port = Number(new URL(base).port);
      const body = JSON.stringify({ texts: ["a"] });
      // Eight uploads that never finish hold every slot...
      const stalled = await Promise.all(Array.from({ length: 8 }, () => partialPost(port, body)));
      await delay(100);
      expect((await post(base, { texts: ["a"] })).status).toBe(503);
      // ...until the body deadline answers them 408.
      expect(await Promise.all(stalled.map((u) => u.status))).toEqual(Array(8).fill(408));
      expect((await post(base, { texts: ["a"] })).status).toBe(200);
      // A client that hangs up mid-body frees its slot at once.
      const gone = await Promise.all(Array.from({ length: 8 }, () => partialPost(port, body)));
      await delay(100);
      for (const u of gone) u.socket.destroy();
      await delay(100);
      expect((await post(base, { texts: ["a"] })).status).toBe(200);
    });
  }, 30_000);

  it("answers 408 only to a body that stopped arriving, not a slow one or one the server was too busy to read", async () => {
    await withServer({ BODY_TIMEOUT_MS: "500" }, async ({ base }) => {
      const port = Number(new URL(base).port);
      // A steady upload that takes twice the deadline.
      const body = JSON.stringify({ texts: ["a".repeat(100)] });
      const socket = connect(port, "127.0.0.1");
      await new Promise((r) => socket.once("connect", r));
      let received = "";
      socket.on("data", (c) => (received += c));
      socket.write(`POST /embed HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`);
      for (let i = 0; i < body.length; i += 25) {
        socket.write(body.slice(i, i + 25));
        await delay(250);
      }
      await new Promise((r) => socket.once("close", r));
      expect(received).toMatch(/^HTTP\/1\.1 200/);
    });
    // The loop is held 1.5 s by another request's inference while a body
    // arrives: that body was read once the loop was free, not timed out.
    await withServer({ BODY_TIMEOUT_MS: "500", BLOCK_MS: "1500" }, async ({ base }) => {
      const port = Number(new URL(base).port);
      const body = JSON.stringify({ texts: ["b"] });
      // Its headers are read and its deadline armed; then the loop is held.
      const late = await partialPost(port, body);
      await delay(100);
      const busy = post(base, { texts: ["a"] });
      await delay(300);
      late.finish();
      expect(await late.status).toBe(200);
      expect((await busy).status).toBe(200);
    });
  }, 30_000);

  it("exits promptly on SIGTERM", async () => {
    await withServer({}, async ({ child }) => {
      const started = Date.now();
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(Date.now() - started).toBeLessThan(3000);
    });
  });
});
