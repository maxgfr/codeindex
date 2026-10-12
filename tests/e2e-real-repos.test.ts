import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { renderGraphJson } from "../src/render/graph-json.js";
import type { Graph, SymbolIndex } from "../src/types.js";
import { clonePinned, REPOS, type RealRepo } from "./real-repos.js";

// Empirical validation against REAL public repos, pinned by commit. Opt-in
// (network + minutes of work): `pnpm run test:e2e`. The dangling-rate
// thresholds are a ratchet — pinned near the measured baseline so a resolution
// regression fails loudly, while upstream churn can't (the commits are pinned).
const E2E = !!process.env.CODEINDEX_E2E;

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
