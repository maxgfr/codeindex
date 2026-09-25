// `codeindex status`: a freshness report for the persisted index. Every way an
// index goes stale used to degrade to a silent cold build; these pin that each
// one is named, that the verdict agrees with what `index` then does, and that
// `--check` is usable as a CI gate.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { indexStatus, type IndexStatus } from "../src/status.js";
import { headCommit } from "../src/git.js";
import { ENGINE_VERSION } from "../src/types.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const ENV = { ...process.env, CODEINDEX_EMBED_DIR: "" };

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-status-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  cpSync(FIXTURE, repo, { recursive: true });
  return repo;
}
function cli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: ENV });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}
function index(repo: string, ...flags: string[]): string {
  const res = cli(["index", "--repo", repo, "--out", join(repo, ".codeindex"), ...flags]);
  expect(res.status).toBe(0);
  return res.stderr;
}
function status(repo: string, ...flags: string[]): IndexStatus & { exit: number | null } {
  const res = cli(["status", "--repo", repo, "--check", ...flags]);
  return { ...(JSON.parse(res.stdout) as IndexStatus), exit: res.status };
}
function editCache(repo: string, edit: (cache: Record<string, unknown>) => void): void {
  const path = join(repo, ".codeindex", "cache.json");
  const cache = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(cache);
  writeFileSync(path, JSON.stringify(cache) + "\n");
}

describe("codeindex status", { timeout: 60_000 }, () => {
  it("reports a just-built index fresh, and --check exits 0", () => {
    const repo = freshRepo();
    index(repo);
    const s = status(repo);
    expect(s.exit).toBe(0);
    expect(s).toMatchObject({
      indexDir: join(repo, ".codeindex"),
      present: true,
      usable: true,
      engineVersion: { index: ENGINE_VERSION, current: ENGINE_VERSION },
      artifactsFresh: true,
      stale: [],
    });
    expect(s.reason).toBeUndefined();
    expect(s.files).toEqual({ indexed: 14, unchanged: 14, touched: 0, modified: 0, added: 0, deleted: 0, reextract: 0 });
  });

  it("names file drift, and agrees with what `index` then does", () => {
    const repo = freshRepo();
    index(repo);
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(repo, "src", "util.ts"), later, later); // same content
    let s = status(repo);
    expect(s.files).toMatchObject({ touched: 1, modified: 0 });
    expect([s.artifactsFresh, s.exit]).toEqual([true, 0]); // a touch changes no artifact
    expect(index(repo)).toContain("unchanged — artifacts reused");

    appendFileSync(join(repo, "src", "client.ts"), "\nexport const drift = 1;\n");
    writeFileSync(join(repo, "src", "added.ts"), "export const added = 2;\n");
    rmSync(join(repo, "docs", "api.md"));
    s = status(repo);
    expect(s.files).toMatchObject({ indexed: 14, unchanged: 12, modified: 1, added: 1, deleted: 1 });
    expect(s.stale).toEqual(["files"]);
    expect([s.artifactsFresh, s.exit]).toEqual([false, 1]);
    expect(index(repo)).not.toContain("unchanged");
    expect(status(repo).artifactsFresh).toBe(true);
  });

  // Only a stat mismatch is read and hashed: an edit that keeps both size and
  // mtime is the documented blind spot, and --full-hash looks past it.
  it("hashes only stat-changed files unless --full-hash", () => {
    const repo = freshRepo();
    const file = join(repo, "src", "util.ts");
    const stamp = new Date(2020, 0, 1);
    utimesSync(file, stamp, stamp);
    index(repo);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace("export", "exporT"));
    utimesSync(file, stamp, stamp);
    expect(statSync(file).size).toBe(text.length);
    expect(status(repo).files).toMatchObject({ unchanged: 14, modified: 0 });
    expect(status(repo, "--full-hash").files).toMatchObject({ unchanged: 0, touched: 13, modified: 1 });
  });

  it("names why an index is unusable", () => {
    const repo = freshRepo();
    let s = status(repo);
    expect(s).toMatchObject({ present: false, usable: false, reason: "absent", files: null, artifactsFresh: false, stale: ["absent"] });
    expect(s.exit).toBe(1);

    index(repo);
    const cachePath = join(repo, ".codeindex", "cache.json");
    const original = readFileSync(cachePath, "utf8");
    for (const [edit, reason] of [
      [(c: Record<string, unknown>) => (c.schemaVersion = -1), "schema"],
      [(c: Record<string, unknown>) => (c.extractorVersion = -1), "extractor"],
      [(c: Record<string, unknown>) => ((c.files as Record<string, { hash: string }>)["README.md"]!.hash = "nope"), "corrupt"],
    ] as const) {
      editCache(repo, edit);
      s = status(repo);
      expect(s, reason).toMatchObject({ present: true, usable: false, reason, stale: [reason] });
      writeFileSync(cachePath, original);
    }
    writeFileSync(cachePath, "{ not json");
    expect(status(repo).reason).toBe("corrupt");
    // A read command given that index by name says the same thing.
    const res = cli(["symbols", "--repo", repo, "--index", ".codeindex"]);
    expect(res.stderr).toContain("(cache.json is not a valid index)");
    expect(cli(["symbols", "--repo", repo, "--index", "nowhere"]).stderr).toContain("(no cache.json there)");
  });

  it("names a stale engine version, extraction profile or artifact", () => {
    const repo = freshRepo();
    index(repo);
    editCache(repo, (c) => (c.engineVersion = "0.0.0"));
    expect(status(repo)).toMatchObject({ engineVersion: { index: "0.0.0" }, stale: ["engine-version"], exit: 1 });

    index(repo, "--no-ast");
    const s = status(repo);
    expect(s.stale).toEqual(["extraction"]);
    expect(s.files!.reextract).toBeGreaterThan(0);
    expect(status(repo, "--no-ast").artifactsFresh).toBe(true); // fresh for a --no-ast reader

    index(repo);
    writeFileSync(join(repo, ".codeindex", "graph.json"), "{}\n");
    rmSync(join(repo, ".codeindex", "symbols.json"));
    expect(status(repo).stale).toEqual(["graph.json", "symbols.json"]);
  });

  // A committed index never matches the commit that contains it; the content
  // is what the artifacts describe, and read commands restamp the commit.
  it("reports a moved HEAD without calling the artifacts stale", () => {
    const repo = freshRepo();
    const git = (...args: string[]): void => {
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    };
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "one");
    index(repo);
    const indexed = headCommit(repo)!;
    git("commit", "-q", "--allow-empty", "-m", "two");
    const s = status(repo);
    expect(s.commit).toEqual({ index: indexed, head: headCommit(repo) });
    expect(s.commit.index).not.toBe(s.commit.head);
    expect([s.artifactsFresh, s.exit]).toEqual([true, 0]);
  });

  it("judges the index under this run's scan flags, and never scans the index dir", () => {
    const repo = freshRepo();
    const custom = join(repo, "idx");
    expect(cli(["index", "--repo", repo, "--out", custom, "--scope", "src"]).status).toBe(0);
    const scoped = status(repo, "--index", "idx", "--scope", "src");
    expect(scoped).toMatchObject({ indexDir: custom, artifactsFresh: true });
    const whole = status(repo, "--index", "idx");
    expect(whole.files!.added).toBe(14 - scoped.files!.indexed); // idx/ itself is not among them
    expect(whole.stale).toEqual(["files"]);
    // The library answers the same.
    expect(indexStatus(repo, { scope: "src", out: custom }, "idx")).toEqual(
      (({ exit: _, ...rest }) => rest)(scoped),
    );
  });
});
