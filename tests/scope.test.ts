// --scope / --include / --exclude: how they combine, how a scope may be
// spelled, and that they filter INSIDE the walk (so --max-files counts kept
// files, and directories that cannot hold a kept file are never listed).
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeScope, scanRepo, scanSummary, scanWalkOptions, type ScanOptions } from "../src/scan.js";
import { walk, type WalkSkip } from "../src/walk.js";
import { compileDirExcludes, compileDirGlobs, compileGlobs } from "../src/glob.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

// Root files sort FIRST in the walk, which is what made a capped, scoped walk
// come back empty: the cap was spent on them before the filter dropped them.
const FILES = [
  "a.md",
  "b.py",
  "setup.cfg",
  "docs/index.md",
  "src/README.md",
  "src/flask/app.py",
  "src/flask/cli.py",
  "src/flask/json/__init__.py",
  "src/other/x.py",
  "tests/test_a.py",
];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ci-scope-"));
  for (const rel of FILES) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), `# ${rel}\n`);
  }
  return root;
}

const rels = (root: string, opts: ScanOptions): string[] => scanRepo(root, opts).files.map((f) => f.rel);

describe("--max-files counts files in scope", () => {
  it("a scoped, capped scan keeps files from the scope instead of none", () => {
    const root = fixture();
    const scan = scanRepo(root, { scope: "src/flask", maxFiles: 2 });
    expect(scan.files.map((f) => f.rel)).toEqual(["src/flask/app.py", "src/flask/cli.py"]);
    expect(scan.capped).toBe(true);
  });

  it("so does an include-filtered one, and scanSummary agrees", () => {
    const root = fixture();
    // (The walk is depth-first from a stack, so src/other is entered before
    // src/flask — deterministic, just not rel order.)
    expect(rels(root, { include: ["src/**"], maxFiles: 2 })).toEqual(["src/README.md", "src/other/x.py"]);
    const summary = scanSummary(root, { include: ["src/**"], maxFiles: 2 });
    expect([summary.fileCount, summary.capped]).toEqual([2, true]);
  });
});

describe("scope combines with include/exclude as an intersection", () => {
  it("keeps the included files INSIDE the scope, not the union of both", () => {
    const root = fixture();
    expect(rels(root, { scope: "src", include: ["**/*.md"] })).toEqual(["src/README.md"]);
    expect(rels(root, { scope: "src", include: ["**/*.py"] })).toEqual([
      "src/flask/app.py",
      "src/flask/cli.py",
      "src/flask/json/__init__.py",
      "src/other/x.py",
    ]);
    // Include globs are rooted: a slash-less glob is the top level only, so
    // inside a subdirectory scope it keeps nothing.
    expect(rels(root, { scope: "src", include: ["*.md"] })).toEqual([]);
    expect(rels(root, { scope: "src", exclude: ["src/other/**", "**/*.md"] })).toEqual([
      "src/flask/app.py",
      "src/flask/cli.py",
      "src/flask/json/__init__.py",
    ]);
  });
});

describe("scope spellings", () => {
  it("names the same directory however it is written", () => {
    const root = fixture();
    const expected = rels(root, { scope: "src/flask" });
    expect(expected).toHaveLength(3);
    for (const scope of ["./src/flask", "src/flask/", "src//flask", "src/./flask", "src\\flask", join(root, "src", "flask")]) {
      expect(rels(root, { scope }), scope).toEqual(expected);
    }
    expect(normalizeScope(root, "./src/flask/")).toBe("src/flask");
    expect(normalizeScope(root, join(root, "src"))).toBe("src");
    expect(normalizeScope(root, root)).toBe("");
    expect(normalizeScope(root, ".")).toBe("");
  });

  it("a file scope keeps that one file", () => {
    const root = fixture();
    expect(rels(root, { scope: "src/flask/app.py" })).toEqual(["src/flask/app.py"]);
    expect(rels(root, { scope: "./b.py" })).toEqual(["b.py"]);
  });

  it("a scope outside the repo matches nothing", () => {
    const root = fixture();
    expect(rels(root, { scope: "../elsewhere" })).toEqual([]);
    expect(rels(root, { scope: tmpdir() })).toEqual([]);
  });

  it("include/exclude globs drop a leading ./ and the repo's absolute path", () => {
    const root = fixture();
    expect(rels(root, { include: ["./src/flask/**"] })).toEqual(rels(root, { include: ["src/flask/**"] }));
    expect(rels(root, { include: [`${root}/src/flask/**`] })).toEqual(rels(root, { include: ["src/flask/**"] }));
    expect(rels(root, { exclude: ["./src/**"] })).toEqual(rels(root, { exclude: ["src/**"] }));
  });
});

describe("the filter prunes the walk", () => {
  function skipped(root: string, opts: ScanOptions): WalkSkip[] {
    const skips: WalkSkip[] = [];
    walk(root, { ...scanWalkOptions(root, opts), onSkip: (s) => skips.push(s) });
    return skips;
  }

  it("never lists a directory the scope cannot reach", () => {
    const root = fixture();
    const skips = skipped(root, { scope: "src/flask" });
    const prunedDirs = skips.filter((s) => s.directory && s.reason === "filter").map((s) => s.rel);
    expect(prunedDirs.sort()).toEqual(["docs", "src/other", "tests"]);
    // Nothing beneath a pruned directory was even seen.
    expect(skips.some((s) => /^(docs|tests|src\/other)\//.test(s.rel))).toBe(false);
  });

  it("an exclude of `<dir>/**` prunes that directory whole", () => {
    const root = fixture();
    const prunedDirs = skipped(root, { exclude: ["tests/**", "**/json/**"] })
      .filter((s) => s.directory)
      .map((s) => s.rel);
    expect(prunedDirs.sort()).toEqual(["src/flask/json", "tests"]);
  });

  it("an unfiltered precomputed walk still yields the scoped scan", () => {
    const root = fixture();
    for (const opts of [{ scope: "src" }, { include: ["**/*.md"] }, { scope: "src", exclude: ["src/other/**"] }]) {
      expect(rels(root, { ...opts, precomputedWalk: walk(root) })).toEqual(rels(root, opts));
    }
  });
});

describe("directory pruning predicates", () => {
  it("compileDirGlobs: a directory is entered only when it can hold a match", () => {
    const may = (glob: string, dir: string): boolean => compileDirGlobs([glob])!(dir);
    expect(may("*.md", "src")).toBe(false); // rooted: top-level files only
    expect(may("src/**", "src")).toBe(true);
    expect(may("src/**", "src/a/b")).toBe(true);
    expect(may("src/**", "lib")).toBe(false);
    expect(may("src/*/x.ts", "src/a")).toBe(true);
    expect(may("src/*/x.ts", "src/a/b")).toBe(false);
    expect(may("packages/*", "packages")).toBe(true);
    expect(may("packages/*", "packages/a")).toBe(false);
    expect(may("**/*.ts", "a/b/c")).toBe(true);
    expect(may("a/**/b", "a/x/y")).toBe(true);
    expect(may("s?c/**", "src")).toBe(true);
    expect(compileDirGlobs([])).toBeNull();
  });

  it("compileDirExcludes: only `<prefix>/**` removes a directory whole", () => {
    const whole = compileDirExcludes(["tests/**", "**/gen/**", "*.md"])!;
    expect(whole("tests")).toBe(true);
    expect(whole("src/tests")).toBe(false);
    expect(whole("a/gen")).toBe(true);
    expect(whole("gen")).toBe(true);
    expect(compileDirExcludes(["*.md", "src/*.ts"])).toBeNull();
  });

  // Soundness over a real tree: a directory the predicates prune holds no file
  // the file-level test would keep, for every glob shape below.
  it("never prunes a directory holding a kept file", () => {
    const root = fixture();
    const all = walk(root).files.map((f) => f.rel);
    const dirs = [...new Set(all.flatMap((r) => r.split("/").slice(0, -1).map((_, i, p) => p.slice(0, i + 1).join("/"))))];
    const globs = ["*.md", "**/*.py", "src/**", "src/*/app.py", "src/flask/*", "**/json/**", "s*/**", "*/flask/**", "**", "src/**/x.py"];
    for (const g of globs) {
      const file = compileGlobs([g])!;
      const dir = compileDirGlobs([g])!;
      const whole = compileDirExcludes([g]);
      for (const d of dirs) {
        const under = all.filter((r) => r.startsWith(d + "/"));
        if (!dir(d)) expect(under.filter(file), `${g} pruned ${d}`).toEqual([]);
        if (whole?.(d)) expect(under.every(file), `${g} excluded ${d} whole`).toBe(true);
      }
    }
  });
});

describe("CLI warnings for path flags that match nothing", { timeout: 60_000 }, () => {
  const run = (root: string, ...args: string[]) => {
    const res = spawnSync(process.execPath, [CLI, "scan", "--repo", root, "--no-ast", ...args], { encoding: "utf8" });
    expect(res.status).toBe(0);
    return { count: (JSON.parse(res.stdout) as { fileCount: number }).fileCount, stderr: res.stderr };
  };

  it("a scope that does not exist, or lies outside the repo", () => {
    const root = fixture();
    expect(run(root, "--scope", "nope").stderr).toMatch(/--scope nope does not exist/);
    expect(run(root, "--scope", "../x").stderr).toMatch(/--scope \.\.\/x is outside --repo/);
    const ok = run(root, "--scope", "./src/flask");
    expect([ok.count, ok.stderr]).toEqual([3, ""]);
  });

  it("an --ignore-dir that is a path, while a trailing slash still names the directory", () => {
    const root = fixture();
    expect(run(root, "--ignore-dir", "src/flask").stderr).toMatch(/--ignore-dir takes a directory name.*--exclude 'src\/flask\/\*\*'/);
    const slash = run(root, "--ignore-dir", "tests/");
    expect(slash.stderr).toBe("");
    expect(slash.count).toBe(FILES.length - 1);
  });

  it("an empty result under a rooted include glob names the any-depth spelling", () => {
    const root = fixture();
    const { count, stderr } = run(root, "--scope", "src", "--include", "*.py");
    expect(count).toBe(0);
    expect(stderr).toMatch(/no file of .* was indexed/);
    expect(stderr).toContain("'**/*.py' any depth");
  });
});
