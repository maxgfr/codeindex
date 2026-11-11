// docker/embed/server.mjs without Docker or the real model: the server is
// copied next to a stub of @xenova/transformers and driven over HTTP.
// scripts/test-docker.mjs runs the real image; this covers the server's own
// logic on every run of the suite.
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

  it("runs at most 8 requests at once, large bodies included", async () => {
    await withServer({ SLOW_MS: "400" }, async ({ base }) => {
      // 64 texts of 8 192 characters: the engine's largest batch, ~524 KB,
      // a body that arrives in many reads.
      const big = { texts: Array.from({ length: 64 }, () => "x".repeat(8192)) };
      const results = await Promise.all(Array.from({ length: 24 }, () => post(base, big)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(8);
      expect(results.filter((r) => r.status === 503)).toHaveLength(16);
      expect((await post(base, { texts: ["a"] })).status).toBe(200);
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
