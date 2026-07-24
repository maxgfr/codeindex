import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "../src/types.js";
import { resolveGrammarsDir, resolveGrammarsTier, sharedGrammarsCacheDir } from "../src/ast/loader.js";
import {
  DEFAULT_GRAMMARS_URL,
  extractGrammarsTarball,
  extractTarInto,
  fetchExpectedSha256,
  fetchGrammarsTarball,
  resolveGrammarsPullTarget,
} from "../src/ast/grammars-pull.js";
import type { GrammarsPullTarget } from "../src/engine.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../scripts/engine.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const GRAMMARS_SRC = fileURLToPath(new URL("../scripts/grammars", import.meta.url));

// Tracked so every describe cleans up its tmp dirs.
const allTmp: string[] = [];
afterAll(() => {
  for (const d of allTmp) rmSync(d, { recursive: true, force: true });
});
function mk(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  allTmp.push(d);
  return d;
}

// Env keys with no adjacent grammars so a copied-bundle child resolves via
// cache/none only (neutralize any dev-shell override).
const NEUTRAL = { CODEINDEX_GRAMMAR_DIR: "", ULTRAINDEX_GRAMMAR_DIR: "", CODEINDEX_GRAMMARS_DIR: "" };

// Spawn the CLI ASYNCHRONOUSLY (a mock server runs in THIS process, so a
// blocking child would deadlock the event loop). Returns stdout/stderr/exit.
function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cliPath = CLI,
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((res) => {
    execFile(process.execPath, [cliPath, ...args], { encoding: "utf8", env }, (err, stdout, stderr) => {
      const status = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      res({ stdout: stdout ?? "", stderr: stderr ?? "", status });
    });
  });
}

// Serve `body` (Buffer or string) once on a throwaway loopback port.
async function serveOnce(body: Buffer | string, status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status);
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/asset`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// Build a minimal ustar entry (only the fields the reader looks at). No
// checksum (the reader does not verify it) — test-internal archives only.
function tarEntry(name: string, data: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "utf8");
  header.write(type, 156, "utf8");
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}
function makeTar(entries: { name: string; data: Buffer; type?: string }[]): Buffer {
  return Buffer.concat([...entries.map((e) => tarEntry(e.name, e.data, e.type)), Buffer.alloc(512)]);
}

describe("resolveGrammarsTier — resolution order (adjacent > env > cache > none)", () => {
  const KEYS = ["CODEINDEX_GRAMMAR_DIR", "ULTRAINDEX_GRAMMAR_DIR", "CODEINDEX_GRAMMARS_DIR", "XDG_CACHE_HOME"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // A cache home whose version-dir exists (a "populated" cache).
  function populatedCacheHome(): string {
    const home = mk("ci-gr-cache-");
    mkdirSync(join(home, "codeindex", "grammars", ENGINE_VERSION), { recursive: true });
    return home;
  }

  it("(a) bundle-adjacent grammars/ wins even when env + cache are also present", () => {
    const modDir = mk("ci-gr-mod-");
    mkdirSync(join(modDir, "grammars"));
    process.env.CODEINDEX_GRAMMARS_DIR = mk("ci-gr-env-");
    process.env.XDG_CACHE_HOME = populatedCacheHome();
    const t = resolveGrammarsTier({ moduleDir: modDir });
    expect(t.tier).toBe("adjacent");
    expect(t.dir).toBe(join(modDir, "grammars"));
  });

  it("(b) CODEINDEX_GRAMMARS_DIR wins over the cache when no adjacent dir exists", () => {
    const modDir = mk("ci-gr-mod-"); // no grammars/ subdir
    const envDir = mk("ci-gr-env-");
    process.env.CODEINDEX_GRAMMARS_DIR = envDir;
    process.env.XDG_CACHE_HOME = populatedCacheHome();
    const t = resolveGrammarsTier({ moduleDir: modDir });
    expect(t.tier).toBe("env");
    expect(t.dir).toBe(envDir);
  });

  it("(c) the shared cache is used when neither adjacent nor env resolve", () => {
    const modDir = mk("ci-gr-mod-");
    const home = populatedCacheHome();
    process.env.XDG_CACHE_HOME = home;
    const t = resolveGrammarsTier({ moduleDir: modDir });
    const cdir = join(home, "codeindex", "grammars", ENGINE_VERSION);
    expect(t.tier).toBe("cache");
    expect(t.dir).toBe(cdir);
    expect(t.cacheDir).toBe(cdir);
  });

  it("(d) none → tier 'none', dir undefined (the regex-tier signal)", () => {
    const modDir = mk("ci-gr-mod-");
    process.env.XDG_CACHE_HOME = mk("ci-gr-empty-"); // no version dir under it
    const t = resolveGrammarsTier({ moduleDir: modDir });
    expect(t.tier).toBe("none");
    expect(t.dir).toBeUndefined();
    expect(resolveGrammarsDir({ moduleDir: modDir })).toBeUndefined();
  });

  it("legacy CODEINDEX_GRAMMAR_DIR (singular) still overrides outright", () => {
    const modDir = mk("ci-gr-mod-");
    mkdirSync(join(modDir, "grammars")); // adjacent present…
    const legacy = mk("ci-gr-legacy-");
    process.env.CODEINDEX_GRAMMAR_DIR = legacy; // …but the explicit legacy override still wins
    const t = resolveGrammarsTier({ moduleDir: modDir });
    expect(t.tier).toBe("env");
    expect(t.dir).toBe(legacy);
  });

  it("sharedGrammarsCacheDir is version-scoped and honors XDG_CACHE_HOME", () => {
    process.env.XDG_CACHE_HOME = join(tmpdir(), "xdg-fixed");
    expect(sharedGrammarsCacheDir()).toBe(join(tmpdir(), "xdg-fixed", "codeindex", "grammars", ENGINE_VERSION));
  });
});

describe("resolveGrammarsPullTarget — default asset + custom override", () => {
  const prev = process.env.CODEINDEX_GRAMMARS_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.CODEINDEX_GRAMMARS_URL;
    else process.env.CODEINDEX_GRAMMARS_URL = prev;
  });

  it("GrammarsPullTarget is exported from the barrel and types the return", () => {
    delete process.env.CODEINDEX_GRAMMARS_URL;
    const target: GrammarsPullTarget | undefined = resolveGrammarsPullTarget();
    expect(target?.url).toBe(DEFAULT_GRAMMARS_URL);
  });

  it("falls back to the per-release default + its .sha256 sidecar when env unset", () => {
    delete process.env.CODEINDEX_GRAMMARS_URL;
    const t = resolveGrammarsPullTarget();
    expect(t.url).toBe(DEFAULT_GRAMMARS_URL);
    expect(t.url).toMatch(/^https:\/\/github\.com\/.*\/releases\/download\/v\d+\.\d+\.\d+\/grammars-\d+\.\d+\.\d+\.tar\.gz$/);
    expect(t.sha256Url).toBe(`${DEFAULT_GRAMMARS_URL}.sha256`);
  });

  it("CODEINDEX_GRAMMARS_URL wins and carries NO checksum (custom mirror = unverified)", () => {
    process.env.CODEINDEX_GRAMMARS_URL = "  https://mirror.test/g.tar.gz  ";
    const t = resolveGrammarsPullTarget();
    expect(t.url).toBe("https://mirror.test/g.tar.gz"); // trimmed
    expect(t.sha256Url).toBeUndefined();
  });
});

describe("fetchGrammarsTarball — sha256 verification (mirrors fetchEmbedModel)", () => {
  it("returns the bytes when the sha256 matches", async () => {
    const body = Buffer.from("grammars tarball bytes");
    const sha = createHash("sha256").update(body).digest("hex");
    const srv = await serveOnce(body);
    try {
      const got = await fetchGrammarsTarball(srv.url, sha);
      expect(Buffer.from(got).equals(body)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("THROWS on a sha256 mismatch (corrupt/tampered asset → nothing usable returned)", async () => {
    const srv = await serveOnce(Buffer.from("grammars tarball bytes"));
    try {
      await expect(fetchGrammarsTarball(srv.url, "0".repeat(64))).rejects.toThrow(/sha256 mismatch/);
    } finally {
      await srv.close();
    }
  });

  it("with NO expected sha256 (custom URL) skips verification entirely", async () => {
    const srv = await serveOnce(Buffer.from("anything"));
    try {
      const got = await fetchGrammarsTarball(srv.url);
      expect(Buffer.from(got).toString()).toBe("anything");
    } finally {
      await srv.close();
    }
  });

  it("throws on a non-2xx response", async () => {
    const srv = await serveOnce("nope", 404);
    try {
      await expect(fetchGrammarsTarball(srv.url)).rejects.toThrow(/HTTP 404/);
    } finally {
      await srv.close();
    }
  });
});

describe("fetchExpectedSha256 — sidecar parsing", () => {
  it("parses a bare hex line", async () => {
    const hex = "a".repeat(64);
    const srv = await serveOnce(hex + "\n");
    try {
      expect(await fetchExpectedSha256(srv.url)).toBe(hex);
    } finally {
      await srv.close();
    }
  });

  it("parses a 'hex  filename' line (sha256sum format)", async () => {
    const hex = "b".repeat(64);
    const srv = await serveOnce(`${hex}  grammars-9.9.9.tar.gz\n`);
    try {
      expect(await fetchExpectedSha256(srv.url)).toBe(hex);
    } finally {
      await srv.close();
    }
  });

  it("throws on a malformed sidecar", async () => {
    const srv = await serveOnce("not a valid hash");
    try {
      await expect(fetchExpectedSha256(srv.url)).rejects.toThrow(/invalid sha256 sidecar/);
    } finally {
      await srv.close();
    }
  });
});

describe("tar extraction + path-traversal guard", () => {
  it("extracts regular files, stripping ./ and skipping directory entries", () => {
    const dest = mk("ci-gr-x-");
    const tar = makeTar([
      { name: "./", data: Buffer.alloc(0), type: "5" },
      { name: "./web-tree-sitter.wasm", data: Buffer.from("rt") },
      { name: "typescript.wasm", data: Buffer.from("ts") },
    ]);
    const written = extractTarInto(tar, dest);
    expect(written.sort()).toEqual(["typescript.wasm", "web-tree-sitter.wasm"]);
    expect(readFileSync(join(dest, "web-tree-sitter.wasm")).toString()).toBe("rt");
    expect(readFileSync(join(dest, "typescript.wasm")).toString()).toBe("ts");
  });

  it("extractGrammarsTarball gunzips then extracts", () => {
    const dest = mk("ci-gr-gz-");
    const gz = gzipSync(makeTar([{ name: "web-tree-sitter.wasm", data: Buffer.from("zz") }]));
    extractGrammarsTarball(gz, dest);
    expect(readFileSync(join(dest, "web-tree-sitter.wasm")).toString()).toBe("zz");
  });

  it("rejects a '..' traversal entry BEFORE writing outside the destination", () => {
    const dest = mk("ci-gr-trav-");
    const tar = makeTar([{ name: "../evil.wasm", data: Buffer.from("pwned") }]);
    expect(() => extractTarInto(tar, dest)).toThrow(/unsafe tar entry/);
    expect(existsSync(join(dirname(dest), "evil.wasm"))).toBe(false);
  });

  it("rejects an absolute-path entry", () => {
    const dest = mk("ci-gr-abs-");
    const tar = makeTar([{ name: "/etc/evil.wasm", data: Buffer.from("x") }]);
    expect(() => extractTarInto(tar, dest)).toThrow(/unsafe tar entry/);
  });
});

describe("CLI grammars status + pull", () => {
  it("`grammars status` reports the adjacent tier + shape from the shipped bundle", async () => {
    const { stdout, status } = await runCli(["grammars", "status"], { ...process.env, ...NEUTRAL });
    expect(status).toBe(0);
    const p = JSON.parse(stdout) as {
      engineVersion: string;
      tier: string;
      dir: string | null;
      cacheDir: string;
      runtimePresent: boolean;
      pullNeeded: boolean;
      url: string;
    };
    expect(p.engineVersion).toBe(ENGINE_VERSION);
    expect(p.tier).toBe("adjacent");
    expect(typeof p.dir).toBe("string");
    expect(p.dir!.endsWith("grammars")).toBe(true);
    expect(p.cacheDir).toContain(join("codeindex", "grammars", ENGINE_VERSION));
    expect(p.runtimePresent).toBe(true);
    expect(p.pullNeeded).toBe(false);
    expect(p.url).toMatch(/grammars-\d+\.\d+\.\d+\.tar\.gz$/);
  });

  it("`grammars pull` fetches a (custom-URL) tarball, extracts it into the cache, and status flips to the cache tier", async () => {
    const runtime = Buffer.from("dummy-runtime-wasm-bytes");
    const ts = Buffer.from("dummy-typescript-wasm");
    const gz = gzipSync(makeTar([
      { name: "./web-tree-sitter.wasm", data: runtime },
      { name: "./typescript.wasm", data: ts },
    ]));
    const srv = await serveOnce(gz);
    const cacheHome = mk("ci-gr-pullc-");
    const bundleDir = mk("ci-gr-pullb-");
    copyFileSync(BUNDLE, join(bundleDir, "engine.mjs"));
    copyFileSync(CLI, join(bundleDir, "cli.mjs"));
    const env = { ...process.env, ...NEUTRAL, CODEINDEX_GRAMMARS_URL: srv.url, XDG_CACHE_HOME: cacheHome };
    const cdir = join(cacheHome, "codeindex", "grammars", ENGINE_VERSION);
    try {
      const pull = await runCli(["grammars", "pull"], env, join(bundleDir, "cli.mjs"));
      expect(pull.status).toBe(0);
      expect(readFileSync(join(cdir, "web-tree-sitter.wasm")).equals(runtime)).toBe(true);
      expect(readFileSync(join(cdir, "typescript.wasm")).equals(ts)).toBe(true);

      const st = await runCli(["grammars", "status"], env, join(bundleDir, "cli.mjs"));
      const p = JSON.parse(st.stdout) as { tier: string; dir: string; runtimePresent: boolean; pullNeeded: boolean };
      expect(p.tier).toBe("cache");
      expect(p.dir).toBe(cdir);
      expect(p.runtimePresent).toBe(true);
      expect(p.pullNeeded).toBe(false);

      // Idempotent: a second pull succeeds and leaves the cache intact.
      const pull2 = await runCli(["grammars", "pull"], env, join(bundleDir, "cli.mjs"));
      expect(pull2.status).toBe(0);
      expect(readFileSync(join(cdir, "web-tree-sitter.wasm")).equals(runtime)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("a tarball missing the runtime wasm is rejected atomically (nothing installed)", async () => {
    const gz = gzipSync(makeTar([{ name: "./typescript.wasm", data: Buffer.from("x") }]));
    const srv = await serveOnce(gz);
    const cacheHome = mk("ci-gr-nort-");
    const bundleDir = mk("ci-gr-nortb-");
    copyFileSync(BUNDLE, join(bundleDir, "engine.mjs"));
    copyFileSync(CLI, join(bundleDir, "cli.mjs"));
    const env = { ...process.env, ...NEUTRAL, CODEINDEX_GRAMMARS_URL: srv.url, XDG_CACHE_HOME: cacheHome };
    try {
      const pull = await runCli(["grammars", "pull"], env, join(bundleDir, "cli.mjs"));
      expect(pull.status).not.toBe(0);
      expect(existsSync(join(cacheHome, "codeindex", "grammars", ENGINE_VERSION))).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it("OFFLINE-SAFE: a failed pull exits non-zero and writes nothing; indexing still succeeds via the regex tier", async () => {
    const srv = await serveOnce("not found", 404);
    const cacheHome = mk("ci-gr-off-");
    const bundleDir = mk("ci-gr-offb-");
    copyFileSync(BUNDLE, join(bundleDir, "engine.mjs"));
    copyFileSync(CLI, join(bundleDir, "cli.mjs"));
    const env = { ...process.env, ...NEUTRAL, CODEINDEX_GRAMMARS_URL: srv.url, XDG_CACHE_HOME: cacheHome };
    try {
      const pull = await runCli(["grammars", "pull"], env, join(bundleDir, "cli.mjs"));
      expect(pull.status).not.toBe(0);
      expect(existsSync(join(cacheHome, "codeindex", "grammars", ENGINE_VERSION))).toBe(false);

      // The grammars are absent everywhere → indexing must NOT throw; regex tier
      // still resolves imports. (graph runs from the copied bundle, no adjacent.)
      const graph = await runCli(["graph", "--repo", REPO], env, join(bundleDir, "cli.mjs"));
      expect(graph.status).toBe(0);
      const parsed = JSON.parse(graph.stdout) as { fileEdges: { kind: string }[] };
      expect(parsed.fileEdges.some((e) => e.kind === "import")).toBe(true);
    } finally {
      await srv.close();
    }
  });
});

describe("byte-identical extraction: adjacent dir vs the same wasm in the shared cache", () => {
  it("graph.json is byte-for-byte identical whether the wasm comes from adjacent or cache", async () => {
    // A — adjacent tier: the shipped CLI resolves scripts/grammars next to the bundle.
    const a = await runCli(["graph", "--repo", REPO], { ...process.env, ...NEUTRAL }, CLI);
    expect(a.status).toBe(0);

    // B — cache tier: a copied bundle with NO adjacent grammars, the identical
    // wasm bytes placed in the version-scoped shared cache.
    const bundleDir = mk("ci-gr-idb-");
    copyFileSync(BUNDLE, join(bundleDir, "engine.mjs"));
    copyFileSync(CLI, join(bundleDir, "cli.mjs"));
    const cacheHome = mk("ci-gr-idc-");
    const cdir = join(cacheHome, "codeindex", "grammars", ENGINE_VERSION);
    mkdirSync(dirname(cdir), { recursive: true });
    cpSync(GRAMMARS_SRC, cdir, { recursive: true });
    const envB = { ...process.env, ...NEUTRAL, XDG_CACHE_HOME: cacheHome };
    const b = await runCli(["graph", "--repo", REPO], envB, join(bundleDir, "cli.mjs"));
    expect(b.status).toBe(0);

    // The whole point of the tier: same bytes → same AST → same symbols → same JSON.
    expect(b.stdout).toBe(a.stdout);

    // …and it really was the cache that served B.
    const st = await runCli(["grammars", "status"], envB, join(bundleDir, "cli.mjs"));
    const p = JSON.parse(st.stdout) as { tier: string; dir: string; runtimePresent: boolean };
    expect(p.tier).toBe("cache");
    expect(p.dir).toBe(cdir);
    expect(p.runtimePresent).toBe(true);
  });
});
