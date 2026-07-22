import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { renderGraphJson } from "../src/render/graph-json.js";
import type { Graph, SymbolIndex } from "../src/types.js";

// Empirical validation against REAL public repos, pinned by commit. Opt-in
// (network + minutes of work): `pnpm run test:e2e`. The dangling-rate
// thresholds are a ratchet — pinned near the measured baseline so a resolution
// regression fails loudly, while upstream churn can't (the commits are pinned).
const E2E = !!process.env.CODEINDEX_E2E;

const CACHE = fileURLToPath(new URL("./.e2e-cache", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../scripts/engine.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const KNOWN_REASONS = new Set([
  "missing-module",
  "alias-unresolved",
  "escapes-repo-root",
  "missing-package",
  "missing-include",
  "missing-target",
]);

interface RealRepo {
  slug: string; // owner/name on GitHub
  sha: string; // pinned commit — re-pin deliberately, never float
  maxDanglingRatio: number; // ratchet: dangling / total edges must stay below
  primaryLang: string; // symbols.json must contain defs in this language
  // A resolved import edge that must exist (from-prefix, to-prefix) — the
  // regression teeth proving resolution actually worked here.
  crossEdge?: [RegExp, RegExp];
  budgetMs: number; // generous wall-clock ceiling for one cold build
}

const REPOS: RealRepo[] = [
  {
    // Yarn workspaces + Next.js app dir (the original adversarial-audit anchor).
    slug: "socialgouv/code-du-travail-numerique",
    sha: "886297ad7ce94d6377863d8fbf88e24f696dd3b7",
    maxDanglingRatio: 0.002,
    primaryLang: "typescript",
    crossEdge: [/^packages\/code-du-travail-frontend\//, /^packages\/(?!code-du-travail-frontend\/)/],
    budgetMs: 120_000,
  },
  {
    // Turborepo + pnpm; packages route subpaths through conditional `exports`.
    slug: "t3-oss/create-t3-turbo",
    sha: "8f945b7bb3bfb3ca8358d48b1ff0214079bc11ee",
    maxDanglingRatio: 0.02,
    primaryLang: "typescript",
    crossEdge: [/^apps\//, /^packages\//],
    budgetMs: 120_000,
  },
  {
    // Canonical Nx layout: root tsconfig.base.json carrying the @org/* aliases.
    slug: "nrwl/nx-examples",
    sha: "0808ace9640cdae6fbbc9b000292383ea6d78c9f",
    maxDanglingRatio: 0.01,
    primaryLang: "typescript",
    crossEdge: [/^apps\//, /^libs\//],
    budgetMs: 120_000,
  },
  {
    // Python: package imports, src layout.
    slug: "pallets/flask",
    sha: "36e4a824f340fdee7ed50937ba8e7f6bc7d17f81",
    maxDanglingRatio: 0.01, // measured baseline: 0/582 edges
    primaryLang: "python",
    crossEdge: [/^tests\//, /^src\/flask\//],
    budgetMs: 120_000,
  },
  {
    // Go: module-rooted imports via go.mod.
    slug: "gin-gonic/gin",
    sha: "34dac209ffb6ef85cc78c5d217bbb7ad001d68fd",
    maxDanglingRatio: 0.03, // measured baseline: 5/267 edges (1.87%)
    primaryLang: "go",
    budgetMs: 120_000,
  },
  {
    // Rust: cargo workspace (crates/*), mod/use resolution.
    slug: "BurntSushi/ripgrep",
    sha: "59e318f5ace48db54f37bb67c152535bc17fa153",
    maxDanglingRatio: 0.01, // measured baseline: 0/619 edges
    primaryLang: "rust",
    crossEdge: [/^crates\/core\//, /^crates\/(?!core\/)/],
    budgetMs: 120_000,
  },
];

// Shallow-fetch the pinned commit into the cache; re-runs are offline.
function clonePinned(repo: RealRepo): string {
  const dir = join(CACHE, `${repo.slug.replace("/", "__")}@${repo.sha.slice(0, 12)}`);
  if (existsSync(join(dir, ".git"))) return dir;
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("remote", "add", "origin", `https://github.com/${repo.slug}`);
  git("fetch", "-q", "--depth", "1", "origin", repo.sha);
  git("checkout", "-q", "FETCH_HEAD");
  return dir;
}

// Build once per repo per run; every assertion shares the result.
const built = new Map<string, { graph: Graph; symbols: SymbolIndex; repoDir: string; ms: number }>();
function buildOnce(repo: RealRepo) {
  let b = built.get(repo.slug);
  if (!b) {
    const repoDir = clonePinned(repo);
    const t0 = performance.now();
    const { graph, symbols } = buildIndexArtifacts(repoDir);
    const ms = performance.now() - t0;
    built.set(repo.slug, (b = { graph, symbols, repoDir, ms }));
  }
  return b;
}

describe.skipIf(!E2E).each(REPOS)("real repo: $slug", (repo) => {
  it("builds without throwing, under the ratchet and the time budget", { timeout: 900_000 }, () => {
    const { graph, ms } = buildOnce(repo);
    const dangling = graph.fileEdges.filter((e) => e.dangling).length;
    const ratio = graph.fileEdges.length ? dangling / graph.fileEdges.length : 0;
    // eslint-disable-next-line no-console
    console.log(
      `${repo.slug}: ${graph.fileCount} files, ${graph.fileEdges.length} edges, ${dangling} dangling (${(ratio * 100).toFixed(2)}%), ${(ms / 1000).toFixed(1)}s`,
    );
    expect(ratio).toBeLessThan(repo.maxDanglingRatio);
    expect(ms).toBeLessThan(repo.budgetMs);
  });

  it("only reports KNOWN dangling reasons (self-diagnosing contract)", { timeout: 60_000 }, () => {
    const { graph } = buildOnce(repo);
    const reasons = new Set(graph.fileEdges.filter((e) => e.dangling).map((e) => e.reason ?? ""));
    for (const r of reasons) expect(KNOWN_REASONS.has(r), `unknown dangling reason "${r}"`).toBe(true);
  });

  it("extracts symbols in the repo's primary language", { timeout: 60_000 }, () => {
    const { symbols } = buildOnce(repo);
    const count = Object.values(symbols.defs).filter((defs) => defs.some((d) => d.lang === repo.primaryLang)).length;
    expect(count, `no ${repo.primaryLang} symbols extracted`).toBeGreaterThan(0);
  });

  it("resolves a real cross-area import edge", { timeout: 60_000 }, () => {
    if (!repo.crossEdge) return;
    const { graph } = buildOnce(repo);
    const [fromRe, toRe] = repo.crossEdge;
    const hit = graph.fileEdges.some(
      (e) => e.kind === "import" && !e.dangling && fromRe.test(e.from) && toRe.test(e.to),
    );
    expect(hit, `no resolved import edge matching ${fromRe} → ${toRe}`).toBe(true);
  });

  it("is deterministic: a second build produces byte-identical graph.json", { timeout: 900_000 }, () => {
    const { graph, repoDir } = buildOnce(repo);
    const { graph: again } = buildIndexArtifacts(repoDir);
    expect(renderGraphJson(again)).toBe(renderGraphJson(graph));
  });
});

describe.skipIf(!E2E)("engine-only no-wasm mode (vendored consumer layout)", () => {
  it.each([REPOS[1]!, REPOS[3]!])(
    "$slug: the bundle alone still resolves imports and extracts symbols",
    { timeout: 900_000 },
    (repo) => {
      const repoDir = clonePinned(repo);
      const dir = mkdtempSync(join(tmpdir(), "ci-e2e-nowasm-"));
      copyFileSync(BUNDLE, join(dir, "engine.mjs"));
      copyFileSync(CLI, join(dir, "cli.mjs"));
      const lone = join(dir, "cli.mjs");
      const env = { ...process.env, CODEINDEX_GRAMMAR_DIR: "", ULTRAINDEX_GRAMMAR_DIR: "" };
      const out1 = join(dir, "out1");
      const out2 = join(dir, "out2");
      execFileSync(process.execPath, [lone, "index", "--repo", repoDir, "--out", out1], { env, stdio: "pipe" });
      execFileSync(process.execPath, [lone, "index", "--repo", repoDir, "--out", out2], { env, stdio: "pipe" });
      const graph = JSON.parse(readFileSync(join(out1, "graph.json"), "utf8")) as Graph;
      const symbols = JSON.parse(readFileSync(join(out1, "symbols.json"), "utf8")) as SymbolIndex;
      // Imports are regex-extracted in both tiers — edges must survive no-wasm.
      expect(graph.fileEdges.some((e) => e.kind === "import" && !e.dangling)).toBe(true);
      expect(Object.keys(symbols.defs).length).toBeGreaterThan(0);
      expect(readFileSync(join(out2, "graph.json"), "utf8")).toBe(readFileSync(join(out1, "graph.json"), "utf8"));
    },
  );
});

describe.skipIf(!E2E)("committed bundle smoke", () => {
  it("the shipped engine.mjs indexes a real repo", { timeout: 900_000 }, () => {
    const repoDir = clonePinned(REPOS[1]!); // the smallest of the matrix
    const out = join(mkdtempSync(join(tmpdir(), "ci-e2e-")), "out");
    execFileSync(process.execPath, [CLI, "index", "--repo", repoDir, "--out", out], { stdio: "pipe" });
    const graph = JSON.parse(readFileSync(join(out, "graph.json"), "utf8")) as Graph;
    expect(graph.fileCount).toBeGreaterThan(0);
    expect(graph.modules.length).toBeGreaterThan(0);
  });
});
