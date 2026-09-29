// freshness.json: the stamps a freshness proof needs, without cache.json's
// records. `graph`, `symbols`, the graph-only commands, `status` and an `index`
// with nothing to write used to JSON.parse the whole cache.json (142MB on
// typescript-go) first. The proof must reach exactly the verdict the
// cache.json path reaches: these pin both that it is used and that it never
// vouches for a stale artifact.
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha1 } from "../src/hash.js";
import { freshArtifacts, readFreshness } from "../src/freshness.js";
import { readPersistedIndex } from "../src/preload.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const ENV = { ...process.env, CODEINDEX_EMBED_DIR: "" };

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-freshness-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  cpSync(FIXTURE, repo, { recursive: true });
  return repo;
}
function cli(args: string[]): { stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: ENV });
  if (res.status !== 0) throw new Error(`cli ${args.join(" ")} exited ${res.status}: ${res.stderr}`);
  return { stdout: res.stdout, stderr: res.stderr };
}
const idx = (repo: string, name = ""): string => join(repo, ".codeindex", name);
const index = (repo: string, ...flags: string[]): string => cli(["index", "--repo", repo, "--out", idx(repo), ...flags]).stderr;
const read = (repo: string, ...args: string[]): string => cli([...args, "--repo", repo]).stdout;

// Replace cache.json with garbage of the same size, and record its new stat in
// freshness.json as if the two had been written together: a reader that trusts
// freshness.json never notices, while any reader that parses cache.json falls
// back to a cold build. (utimes cannot restore a sub-millisecond mtime, so the
// stamp is moved to the file rather than the file to the stamp.)
function poisonCache(repo: string): void {
  const path = idx(repo, "cache.json");
  writeFileSync(path, "x".repeat(statSync(path).size));
  const fresh = JSON.parse(readFileSync(idx(repo, "freshness.json"), "utf8")) as Record<string, unknown>;
  const st = statSync(path);
  fresh.cache = { size: st.size, mtimeMs: st.mtimeMs };
  writeFileSync(idx(repo, "freshness.json"), JSON.stringify(fresh) + "\n");
}
// Rewrite graph.json and record its sha in freshness.json only.
function doctorGraph(repo: string, bytes: string): void {
  writeFileSync(idx(repo, "graph.json"), bytes);
  const fresh = JSON.parse(readFileSync(idx(repo, "freshness.json"), "utf8")) as Record<string, unknown>;
  fresh.graphSha1 = sha1(bytes);
  writeFileSync(idx(repo, "freshness.json"), JSON.stringify(fresh) + "\n");
}

describe("freshness.json", { timeout: 60_000 }, () => {
  it("is written by index with cache.json's stamps and cache.json's own stat", () => {
    const repo = freshRepo();
    index(repo);
    const fresh = readFreshness(repo)!;
    const persisted = readPersistedIndex(repo)!;
    expect(fresh.meta).toEqual({ ...persisted.meta, embed: undefined });
    expect([...fresh.files.keys()]).toEqual([...persisted.cacheMap.keys()]);
    for (const [rel, e] of persisted.cacheMap) expect(fresh.files.get(rel)).toEqual({ hash: e.hash, size: e.size, mtimeMs: e.mtimeMs });
    const st = statSync(idx(repo, "cache.json"));
    expect(fresh.cache).toEqual({ size: st.size, mtimeMs: st.mtimeMs });
    // An index that predates it gains it on the next clean `index`, and that
    // run still leaves cache.json alone.
    const written = readFileSync(idx(repo, "freshness.json"), "utf8");
    rmSync(idx(repo, "freshness.json"));
    expect(index(repo)).toContain("(unchanged — artifacts reused)");
    expect(readFileSync(idx(repo, "freshness.json"), "utf8")).toBe(written);
    expect(statSync(idx(repo, "cache.json")).mtimeMs).toBe(st.mtimeMs);
    // A cache.json rewritten without it (an older engine's `index`) disowns it.
    appendFileSync(idx(repo, "cache.json"), " ");
    expect(readFreshness(repo)).toBeUndefined();
  });

  it("lets graph/symbols and graph-only commands answer without parsing cache.json", () => {
    const repo = freshRepo();
    index(repo);
    const symbols = readFileSync(idx(repo, "symbols.json"), "utf8");
    poisonCache(repo);
    const compact = JSON.stringify(JSON.parse(readFileSync(idx(repo, "graph.json"), "utf8"))) + "\n";
    doctorGraph(repo, compact);
    expect(read(repo, "graph")).toBe(compact);
    expect(read(repo, "symbols")).toBe(symbols);
    expect(JSON.parse(read(repo, "impact", "src/util.ts"))).toBeDefined();
    const status = JSON.parse(read(repo, "status")) as { usable: boolean; artifactsFresh: boolean };
    expect([status.usable, status.artifactsFresh]).toEqual([true, true]);
  });

  it("never vouches for stale artifacts", () => {
    const repo = freshRepo();
    index(repo);
    const at = (...args: string[]): unknown => freshArtifacts(repo, { out: idx(repo), ...Object.fromEntries(args.map((a) => [a, true])) });
    expect(at()).toBeDefined();
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(repo, "src", "util.ts"), later, later);
    expect(at()).toBeDefined(); // touched: re-hashed, same content
    expect(freshArtifacts(repo, { scope: "src" })).toBeUndefined(); // another file set
    expect(freshArtifacts(repo, { ast: false })).toBeUndefined(); // records built at the AST tier
    expect(freshArtifacts(repo, { maxCallsPerFile: 3 })).toBeUndefined();
    appendFileSync(join(repo, "src", "util.ts"), "\nexport const drifted = 1;\n");
    expect(at()).toBeUndefined();
    expect(read(repo, "symbols")).toBe(read(repo, "symbols", "--no-index-cache"));
    expect(read(repo, "symbols")).toContain("drifted");
    // A corrupt freshness.json only costs the fast path.
    index(repo);
    writeFileSync(idx(repo, "freshness.json"), "{");
    expect(readFreshness(repo)).toBeUndefined();
    expect(read(repo, "graph")).toBe(readFileSync(idx(repo, "graph.json"), "utf8"));
  });
});

describe("index with nothing to write", { timeout: 60_000 }, () => {
  it("is decided from freshness.json, without parsing cache.json", () => {
    const repo = freshRepo();
    index(repo);
    poisonCache(repo);
    const poisoned = readFileSync(idx(repo, "cache.json"), "utf8");
    expect(index(repo)).toContain("(unchanged — artifacts reused)");
    expect(readFileSync(idx(repo, "cache.json"), "utf8")).toBe(poisoned); // nothing written
    // --full-hash, the escape hatch, still reads everything and repairs it.
    expect(index(repo, "--full-hash")).not.toContain("unchanged");
    expect(readPersistedIndex(repo)).toBeDefined();
  });

  it("takes the full path for anything the fastpath would write", () => {
    const repo = freshRepo();
    index(repo);
    const cacheBytes = (): string => readFileSync(idx(repo, "cache.json"), "utf8");
    const before = cacheBytes();
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(repo, "src", "util.ts"), later, later);
    // A touch rewrites cache.json's (size, mtime) keys, and freshness.json with it.
    expect(index(repo)).toContain("(unchanged — artifacts reused)");
    expect(cacheBytes()).not.toBe(before);
    expect(readFreshness(repo)?.files.get("src/util.ts")?.mtimeMs).toBe(statSync(join(repo, "src", "util.ts")).mtimeMs);
    const settled = cacheBytes();
    expect(index(repo)).toContain("(unchanged — artifacts reused)");
    expect(cacheBytes()).toBe(settled);
    // Another --max-calls: the profile changes, so the records are rebuilt.
    expect(index(repo, "--max-calls", "3")).not.toContain("unchanged");
  });
});
