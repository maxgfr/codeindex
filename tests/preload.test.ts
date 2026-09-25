import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { preloadSessionLazy, readPersistedIndex } from "../src/preload.js";
import { ensureGrammars, grammarKeysForExts } from "../src/ast/loader.js";
import { scanRepo } from "../src/scan.js";
import { walk } from "../src/walk.js";
import { sha1 } from "../src/hash.js";
import { renderMermaid } from "../src/viz.js";
import type { Graph } from "../src/types.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

// Every read command now consults <repo>/.codeindex before rebuilding. The
// property that matters is not that it is fast — it is that reusing a persisted
// index NEVER changes what the command prints. These tests drive the real CLI
// and compare each command's output against the same command forced to build
// from scratch, in four states: primed, stale, corrupt, and absent.
const READ_COMMANDS = ["graph", "symbols", "repomap", "deadcode", "complexity", "mermaid", "hotspots", "callers"];

function run(repo: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args, "--repo", repo], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function withRepo(fn: (repo: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ci-preload-"));
  try {
    const repo = join(dir, "repo");
    cpSync(REPO, repo, { recursive: true });
    fn(repo);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withRepoAsync(fn: (repo: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ci-preload-async-"));
  try {
    const repo = join(dir, "repo");
    cpSync(REPO, repo, { recursive: true });
    await fn(repo);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const prime = (repo: string): void => {
  run(repo, ["index", "--out", join(repo, ".codeindex")]);
};

// Every test here drives the REAL CLI, and the two output-identity tests spawn
// 17-18 Node processes apiece (prime + each read command twice). Vitest's 5s
// default was never a budget for that: on a 2-core CI runner the drift test
// came in at 5513ms and failed the suite on timing alone, with nothing wrong
// in the behaviour under test. The suite-wide budget is sized for the process
// count, not for the assertion.
describe("persisted-index reuse — output-identical", { timeout: 60_000 }, () => {
  it("every read command agrees with --no-index-cache once primed", () => {
    withRepo((repo) => {
      prime(repo);
      for (const cmd of READ_COMMANDS) {
        expect(run(repo, [cmd]), cmd).toBe(run(repo, [cmd, "--no-index-cache"]));
      }
    });
  });

  it("agrees again after the worktree drifts from the index", () => {
    withRepo((repo) => {
      prime(repo);
      // A real edit: the persisted artifacts no longer describe this tree, so
      // the guard must fail and the pipeline rebuild.
      appendFileSync(join(repo, "src", "client.ts"), "\nexport function addedLater(): number {\n  return 42;\n}\n");
      for (const cmd of READ_COMMANDS) {
        expect(run(repo, [cmd]), cmd).toBe(run(repo, [cmd, "--no-index-cache"]));
      }
      // And the new symbol really is there — proving we did NOT serve the stale
      // artifacts, which is the failure this test exists to catch.
      expect(run(repo, ["symbols"])).toContain("addedLater");
    });
  });

  it("degrades to a cold build on a corrupt index instead of throwing", () => {
    withRepo((repo) => {
      prime(repo);
      for (const [name, bytes] of [
        ["cache.json", "{ this is not json"],
        ["graph.json", '{"schemaVersion":4}'], // valid JSON, wrong sha
      ] as const) {
        const path = join(repo, ".codeindex", name);
        const original = readFileSync(path, "utf8");
        writeFileSync(path, bytes);
        expect(run(repo, ["symbols"]), name).toBe(run(repo, ["symbols", "--no-index-cache"]));
        writeFileSync(path, original);
      }
    });
  });

  it("builds normally when no index exists", () => {
    withRepo((repo) => {
      expect(run(repo, ["symbols"])).toBe(run(repo, ["symbols", "--no-index-cache"]));
    });
  });

  it("honours --index pointing somewhere else", () => {
    withRepo((repo) => {
      run(repo, ["index", "--out", join(repo, "custom-index")]);
      expect(run(repo, ["symbols", "--index", "custom-index"])).toBe(run(repo, ["symbols", "--no-index-cache"]));
      // The default location is empty, so this is a cold build — same output.
      expect(run(repo, ["symbols"])).toBe(run(repo, ["symbols", "--no-index-cache"]));
    });
  });

  // path.join does not reset on an absolute segment: `--index /abs/idx` probed
  // <repo>/abs/idx, found nothing, and every read paid a full cold build. The
  // output was right either way, so only REUSE proves the fix.
  it("reuses an ABSOLUTE --index instead of silently rebuilding", async () => {
    await withRepoAsync(async (repo) => {
      const abs = join(dirname(repo), "elsewhere", "idx");
      run(repo, ["index", "--out", abs]);
      expect(readPersistedIndex(repo, abs)?.cacheMap.size).toBeGreaterThan(0);
      let warms = 0;
      const session = await preloadSessionLazy(repo, {}, async () => {
        warms++;
      }, abs);
      expect(warms).toBe(0);
      expect(session?.scan.contentUnchanged).toBe(true);
      expect(session?.loadArtifacts?.()?.graph.fileCount).toBe(session?.scan.files.length);
      expect(run(repo, ["symbols", "--index", abs])).toBe(run(repo, ["symbols", "--no-index-cache"]));
    });
  });

  // `index` excludes its own --out; the read commands scanned it. An in-repo
  // custom index then showed up as three config files (search answered "graph"
  // with idx/graph.json) and the read scan never matched the index, so its
  // artifacts were never reused.
  it("neither scans nor ignores an in-repo custom --index", async () => {
    await withRepoAsync(async (repo) => {
      run(repo, ["index", "--out", join(repo, "idx")]);
      const hits = JSON.parse(run(repo, ["search", "graph symbols cache", "--index", "idx"])) as { file: string }[];
      expect(hits.some((h) => h.file.startsWith("idx/"))).toBe(false);
      const count = (args: string[]): number => (JSON.parse(run(repo, ["scan", ...args])) as { fileCount: number }).fileCount;
      expect(count(["--index", "idx"])).toBe(scanRepo(repo, { exclude: ["idx/**"] }).files.length);
      let warms = 0;
      // The options the CLI passes for `--index idx`.
      const session = await preloadSessionLazy(repo, { out: join(repo, "idx") }, async () => {
        warms++;
      }, "idx");
      expect(warms).toBe(0);
      expect(session?.scan.contentUnchanged).toBe(true);
      expect(session?.loadArtifacts?.()).toBeDefined();
      expect(run(repo, ["graph", "--index", "idx"])).toBe(readFileSync(join(repo, "idx", "graph.json"), "utf8"));
    });
  });

  it("says so on stderr when a NAMED --index is unusable, and still answers", () => {
    withRepo((repo) => {
      const res = spawnSync(process.execPath, [CLI, "symbols", "--repo", repo, "--index", "no-such-idx"], { encoding: "utf8" });
      expect(res.status).toBe(0);
      expect(res.stderr).toContain(`no usable index at ${join(repo, "no-such-idx")}`);
      expect(res.stdout).toBe(run(repo, ["symbols", "--no-index-cache"]));
      // The default location being empty is the normal first run: no note.
      expect(spawnSync(process.execPath, [CLI, "symbols", "--repo", repo], { encoding: "utf8" }).stderr).not.toContain("no usable index");
    });
  });

  it("does not let a scoped read reuse a whole-repo index", () => {
    withRepo((repo) => {
      prime(repo);
      // The preloaded artifacts describe the WHOLE repo; a --scope read must
      // not serve them. Compare against the same scoped read built cold.
      expect(run(repo, ["symbols", "--scope", "src"])).toBe(run(repo, ["symbols", "--scope", "src", "--no-index-cache"]));
    });
  });
});

// Rewrite one artifact of the primed index and record its new sha in
// cache.json, as `index` would have: the index still vouches for it. Bytes that
// are NOT what a fresh render prints then show which path a command took —
// passing the verified bytes through, or parsing and re-rendering them.
function doctor(repo: string, name: "graph" | "symbols", bytes: string): void {
  const dir = join(repo, ".codeindex");
  writeFileSync(join(dir, `${name}.json`), bytes);
  const cache = JSON.parse(readFileSync(join(dir, "cache.json"), "utf8")) as Record<string, unknown>;
  cache[`${name}Sha1`] = sha1(bytes);
  writeFileSync(join(dir, "cache.json"), JSON.stringify(cache) + "\n");
}
const artifact = (repo: string, name: string): string => readFileSync(join(repo, ".codeindex", `${name}.json`), "utf8");

// graph/symbols parsed BOTH artifacts of a fresh index, then re-rendered the
// one they print: 8.4s/7.6s on typescript-go for bytes already on disk (now
// 5.0s/5.3s, the rest being cache.json and the walk).
describe("a fresh index is read one artifact at a time", { timeout: 60_000 }, () => {
  it("graph and symbols print the verified on-disk bytes as they are", () => {
    withRepo((repo) => {
      prime(repo);
      for (const name of ["graph", "symbols"] as const) {
        const compact = JSON.stringify(JSON.parse(artifact(repo, name))) + "\n";
        doctor(repo, name, compact);
        expect(run(repo, [name]), name).toBe(compact);
      }
    });
  });

  it("symbols never reads graph.json", () => {
    withRepo((repo) => {
      prime(repo);
      rmSync(join(repo, ".codeindex", "graph.json"));
      const compact = JSON.stringify(JSON.parse(artifact(repo, "symbols"))) + "\n";
      doctor(repo, "symbols", compact);
      expect(run(repo, ["symbols"])).toBe(compact);
    });
  });

  it("graph-only commands never read symbols.json", () => {
    withRepo((repo) => {
      prime(repo);
      rmSync(join(repo, ".codeindex", "symbols.json"));
      // A graph the pipeline would not build here, so the answer shows where
      // it came from.
      const graph = JSON.parse(artifact(repo, "graph")) as Graph;
      expect(graph.moduleEdges.length).toBeGreaterThan(0);
      const doctored: Graph = { ...graph, moduleEdges: [] };
      doctor(repo, "graph", JSON.stringify(doctored, null, 2) + "\n");
      expect(run(repo, ["mermaid"])).toBe(renderMermaid(doctored));
      expect(run(repo, ["mermaid"])).not.toBe(run(repo, ["mermaid", "--no-index-cache"]));
    });
  });
});

describe("lazy grammar warm on persisted indexes", { timeout: 30_000 }, () => {
  it("does not warm tree-sitter when the persisted scan is unchanged", async () => {
    await withRepoAsync(async (repo) => {
      prime(repo);
      let warms = 0;
      const result = await preloadSessionLazy(repo, {}, async () => {
        warms++;
      });
      expect(result?.scan.contentUnchanged).toBe(true);
      expect(warms).toBe(0);
      expect(result?.arts).toBeUndefined();
      const artifacts = result?.loadArtifacts?.();
      expect(artifacts?.graph.fileCount).toBe(result?.scan.files.length);
      expect(result?.loadArtifacts?.()).toBe(artifacts);
    });
  });

  it("defers artifact reads until the caller asks for graph-shaped data", async () => {
    await withRepoAsync(async (repo) => {
      prime(repo);
      const result = await preloadSessionLazy(repo, {}, async () => {});
      writeFileSync(join(repo, ".codeindex", "graph.json"), "{ corrupt after preload");
      expect(result?.loadArtifacts?.()).toBeUndefined();
    });
  });

  it("warms and rebuilds changed files at the AST tier", async () => {
    await withRepoAsync(async (repo) => {
      prime(repo);
      appendFileSync(join(repo, "src", "client.ts"), "\nexport function lazyAdded(): number { return 7; }\n");
      const walked = walk(repo, {});
      let warms = 0;
      const result = await preloadSessionLazy(repo, { precomputedWalk: walked }, async () => {
        warms++;
        await ensureGrammars(grammarKeysForExts(walked.files.map((file) => file.ext)));
      });
      expect(warms).toBe(1);
      expect(result?.scan.files.flatMap((file) => file.symbols).some((symbol) => symbol.name === "lazyAdded")).toBe(true);
    });
  });

  // An index built at the regex tier (--no-ast, or before a grammar was
  // available) passed every freshness key, so its records were served forever
  // to a process that extracts at the AST tier. The profile in cache.json makes
  // those records misses: warmed, re-extracted, and the stale artifacts refused.
  it("re-extracts records an index built at another tier", async () => {
    await withRepoAsync(async (repo) => {
      run(repo, ["index", "--out", join(repo, ".codeindex"), "--no-ast"]);
      expect(readPersistedIndex(repo)?.meta.extraction).toEqual({ grammars: [] });
      let warms = 0;
      const session = await preloadSessionLazy(repo, {}, async () => {
        warms++;
      });
      expect(warms).toBe(1);
      expect(session?.scan.contentUnchanged).toBe(false);
      expect(session?.loadArtifacts?.()).toBeUndefined();
      expect(session?.scan.files).toEqual(scanRepo(repo).files);
    });
  });

  it("does not warm for a deletion that needs no new extraction", async () => {
    await withRepoAsync(async (repo) => {
      prime(repo);
      rmSync(join(repo, "src", "client.ts"));
      let warms = 0;
      const result = await preloadSessionLazy(repo, {}, async () => {
        warms++;
      });
      expect(warms).toBe(0);
      expect(result?.scan.files.some((file) => file.rel === "src/client.ts")).toBe(false);
    });
  });

  it("does not warm when only documentation changed", async () => {
    await withRepoAsync(async (repo) => {
      prime(repo);
      appendFileSync(join(repo, "README.md"), "\nA documentation-only cache drift.\n");
      let warms = 0;
      const result = await preloadSessionLazy(repo, {}, async () => {
        warms++;
      });
      expect(warms).toBe(0);
      expect(result?.scan.contentUnchanged).toBe(false);
      expect(result?.scan.files.find((file) => file.rel === "README.md")?.lines).toBeGreaterThan(10);
    });
  });
});
