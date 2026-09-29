import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, rmSync, readFileSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "../src/scan.js";
import { runExtractWorker, scanRepoParallel, workerCount } from "../src/pool.js";
import { sha1 } from "../src/hash.js";
import { buildIndexArtifacts, buildArtifactsFromScan } from "../src/pipeline.js";
import { renderGraphJson } from "../src/render/graph-json.js";
import { renderSymbolsJson } from "../src/render/symbols-json.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

// THE determinism gate. The in-process tests below exercise the fallback (under
// vitest the worker cannot import the built bundle); this one drives the real
// CLI, where workers genuinely spawn, and pins that the artifacts are identical
// byte for byte to the single-threaded build.
//
// This is the invariant that makes the whole feature safe to enable by default:
// it is checked, not assumed.
describe("parallel extraction — byte-identical to sequential (built CLI)", () => {
  it("produces the same graph.json and symbols.json at --workers 0 and 4", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-par-"));
    try {
      const repo = join(dir, "repo");
      cpSync(REPO, repo, { recursive: true });
      // Exercise a field that symbols.json does not carry. The original worker
      // record forgot literals, so small fixtures without a reported duplicate
      // made this byte-identity gate pass vacuously while real graphs diverged.
      for (const name of ["literal-a.ts", "literal-b.ts", "literal-c.ts"]) {
        writeFileSync(join(repo, "src", name), `export const value = "parallel-regression-value";\n`);
      }
      const build = (out: string, workers: string): void => {
        mkdirSync(out, { recursive: true });
        execFileSync(process.execPath, [CLI, "index", "--repo", repo, "--out", out, "--workers", workers], {
          encoding: "utf8",
        });
      };
      const seq = join(dir, "seq");
      const par = join(dir, "par");
      build(seq, "0");
      build(par, "4");
      for (const artifact of ["graph.json", "symbols.json"]) {
        expect(readFileSync(join(par, artifact), "utf8"), artifact).toBe(readFileSync(join(seq, artifact), "utf8"));
      }
      // A parallel build must actually have produced symbols — a silent
      // fallback to an empty index would otherwise pass the equality above.
      expect(Object.keys(JSON.parse(readFileSync(join(par, "symbols.json"), "utf8")).defs).length).toBeGreaterThan(0);
      expect(readFileSync(join(par, "graph.json"), "utf8")).toContain("parallel-regression-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: the worker records were first consulted BEFORE the cache's
  // hash comparison, which skipped the hash-hit branch entirely. A bare touch
  // (same bytes, new mtime) then reported the scan as changed and rewrote every
  // artifact — silently forfeiting incrementality on the parallel path.
  it("keeps the artifact fastpath after a bare touch", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-par-touch-"));
    try {
      const repo = join(dir, "repo");
      cpSync(REPO, repo, { recursive: true });
      const out = join(dir, "out");
      mkdirSync(out, { recursive: true });
      const run = (): void => {
        execFileSync(process.execPath, [CLI, "index", "--repo", repo, "--out", out, "--workers", "4"], {
          encoding: "utf8",
        });
      };
      run();
      const before = statSync(join(out, "graph.json")).mtimeMs;

      // Bump mtime without changing a byte.
      const target = join(repo, "src", "client.ts");
      const later = new Date(Date.now() + 4000);
      utimesSync(target, later, later);

      run();
      expect(statSync(join(out, "graph.json")).mtimeMs).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a cold read command byte-identical when workers are enabled", () => {
    const run = (workers: string): string =>
      execFileSync(
        process.execPath,
        [CLI, "search", "client", "--repo", REPO, "--workers", workers, "--no-index-cache"],
        { encoding: "utf8" },
      );
    expect(run("4")).toBe(run("0"));
  });

  it("rejects a negative --workers instead of silently guessing", () => {
    expect(() =>
      execFileSync(process.execPath, [CLI, "index", "--repo", REPO, "--out", join(tmpdir(), "nope"), "--workers", "-1"], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow(/--workers expects a non-negative integer/);
  });
});

// The parallel path only ever engages when it can import THIS engine from a
// worker, which needs the built bundle next to the module. Under vitest we run
// from src/, so scanRepoParallel legitimately falls back to sequential — that
// fallback being transparent is itself the property these tests pin.
describe("scanRepoParallel — sequential-identical", () => {
  it("returns records identical to scanRepo", async () => {
    const seq = scanRepo(REPO);
    const par = await scanRepoParallel(REPO, { workers: 4 });
    expect(par.files).toEqual(seq.files);
    expect(par.languages).toEqual(seq.languages);
    expect(par.capped).toBe(seq.capped);
    expect(par.excluded).toBe(seq.excluded);
    expect([...par.docText.entries()]).toEqual([...seq.docText.entries()]);
  });

  it("renders byte-identical artifacts", async () => {
    const seq = buildIndexArtifacts(REPO, {});
    const par = buildArtifactsFromScan(await scanRepoParallel(REPO, { workers: 4 }), {});
    expect(renderGraphJson(par.graph)).toBe(renderGraphJson(seq.graph));
    expect(renderSymbolsJson(par.symbols)).toBe(renderSymbolsJson(seq.symbols));
  });

  it("workers: 0 and 1 take the sequential path", async () => {
    const seq = scanRepo(REPO);
    for (const workers of [0, 1]) {
      const par = await scanRepoParallel(REPO, { workers });
      expect(par.files).toEqual(seq.files);
    }
  });

  it("honours a cache exactly as scanRepo does", async () => {
    const first = scanRepo(REPO);
    const cache = new Map(
      first.files.map((f) => [f.rel, { hash: f.hash, record: f, size: f.size, mtimeMs: 0 }]),
    );
    const seq = scanRepo(REPO, { cache });
    const par = await scanRepoParallel(REPO, { cache, workers: 4 });
    expect(par.files).toEqual(seq.files);
    expect(par.contentUnchanged).toBe(seq.contentUnchanged);
    expect(par.cacheDirty).toBe(seq.cacheDirty);
  });

  it("agrees with scanRepo under scope/include/exclude", async () => {
    for (const opts of [{ scope: "src" }, { include: ["**/*.ts"] }, { exclude: ["docs/**"] }]) {
      const seq = scanRepo(REPO, opts);
      const par = await scanRepoParallel(REPO, { ...opts, workers: 4 });
      expect(par.files).toEqual(seq.files);
    }
  });

  it("handles a repo with no code files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-pool-"));
    try {
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs", "a.md"), "# Only prose\n\nNo code here.\n");
      const seq = scanRepo(dir);
      const par = await scanRepoParallel(dir, { workers: 4 });
      expect(par.files).toEqual(seq.files);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A file queued only because its (size, mtime) moved is usually byte-identical
// (touch, branch round-trip, CI cache restore). The worker used to extract it
// anyway and scanRepo threw the record away on the cache's hash hit: after a
// `touch` of every file, `index --workers 3` took 5x the wall time of the
// sequential scan that merely hashed them.
describe("worker hash check", () => {
  it("skips extraction when the content still hashes to the cached hash", async () => {
    const abs = join(REPO, "src", "client.ts");
    const hash = sha1(readFileSync(abs, "utf8"));
    const posted: Parameters<Parameters<typeof runExtractWorker>[1]>[0][] = [];
    await runExtractWorker(
      {
        jobs: [
          { abs, rel: "src/client.ts", ext: ".ts", cachedHash: hash },
          { abs, rel: "src/client.ts", ext: ".ts", cachedHash: "stale" },
          { abs, rel: "src/client.ts", ext: ".ts" },
        ],
        grammarKeys: [],
      },
      (o) => posted.push(o),
    );
    const [same, changed, fresh] = posted[0]!.records;
    expect(same!.hash).toBe(hash);
    expect(same!.record).toBeUndefined();
    expect(changed!.record?.hash).toBe(hash);
    expect(fresh!.record?.hash).toBe(hash);
  });

  it("scanRepo reuses the cached record for a record-less worker entry, and only then", () => {
    const first = scanRepo(REPO);
    const rel = "src/client.ts";
    const real = first.files.find((f) => f.rel === rel)!;
    const st = statSync(join(REPO, rel));
    const cache = new Map(first.files.map((f) => [f.rel, { hash: f.hash, record: f, size: f.size, mtimeMs: 0 }]));
    // Hash hit: the cached record comes back, the scan still proves itself unchanged.
    const hit = scanRepo(REPO, {
      cache,
      extracted: new Map([[rel, { size: st.size, mtimeMs: st.mtimeMs, hash: real.hash }]]),
    });
    expect(hit.files).toEqual(first.files);
    expect(hit.contentUnchanged).toBe(true);
    // A record-less entry that no longer matches the cache (it was built
    // against another one) is not trusted: the file is read and extracted here.
    const marker = { ...real, summary: "CACHED-MARKER" };
    const stale = new Map(cache).set(rel, { hash: "other", record: marker, size: real.size, mtimeMs: 0 });
    const miss = scanRepo(REPO, {
      cache: stale,
      extracted: new Map([[rel, { size: st.size, mtimeMs: st.mtimeMs, hash: real.hash }]]),
    });
    expect(miss.files.find((f) => f.rel === rel)).toEqual(real);
    expect(miss.contentUnchanged).toBe(false);
  });
});

describe("workerCount", () => {
  const withEnv = <T>(value: string | undefined, fn: () => T): T => {
    const prev = process.env["CODEINDEX_WORKERS"];
    if (value === undefined) delete process.env["CODEINDEX_WORKERS"];
    else process.env["CODEINDEX_WORKERS"] = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env["CODEINDEX_WORKERS"];
      else process.env["CODEINDEX_WORKERS"] = prev;
    }
  };

  it("takes an explicit request over the environment", () => {
    expect(withEnv("8", () => workerCount(0))).toBe(0);
    expect(withEnv("8", () => workerCount(3))).toBe(3);
  });

  it("reads CODEINDEX_WORKERS when nothing is requested", () => {
    expect(withEnv("4", () => workerCount())).toBe(4);
    expect(withEnv("0", () => workerCount())).toBe(0);
  });

  it("treats a nonsense value as sequential rather than guessing", () => {
    expect(withEnv("banana", () => workerCount())).toBe(0);
    expect(withEnv("-2", () => workerCount())).toBe(0);
  });

  it("defaults to a bounded, non-negative count", () => {
    const n = withEnv(undefined, () => workerCount());
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(8);
  });
});
