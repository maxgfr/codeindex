// `scan --why <path>` / `scan --skipped`, and the skip counts in `scan`: every
// reason the walk leaves a path out used to be observable only through a
// library onSkip callback, so a missing file (over --max-bytes, gitignored,
// outside a --scope) was diagnosed with ad-hoc scripts.
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { whyPath, type PathVerdict } from "../src/why.js";
import { parseGitignore } from "../src/ignore.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

const FILES: Record<string, string> = {
  ".gitignore": "# build products\n*.log\n!keep.log\ngen/\n",
  "sub/.gitignore": "secret.txt\n",
  "src/a.ts": "export const a = 1;\n",
  "src/big.ts": `export const big = "${"x".repeat(200)}";\n`,
  "app.log": "noise\n",
  "keep.log": "kept\n",
  "gen/out.ts": "export const gen = 1;\n",
  "sub/secret.txt": "shh\n",
  "sub/open.txt": "hello\n",
  "node_modules/pkg/index.js": "module.exports = 1;\n",
  "yarn.lock": "# lock\n",
  "img.png": "not really a png\n",
  "nested/.git/HEAD": "ref: refs/heads/main\n",
  "nested/n.ts": "export const n = 1;\n",
  "tests/t.ts": "export const t = 1;\n",
  "README.md": "# fixture\n",
  ".git/config": "[core]\n",
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ci-why-"));
  dirs.push(root);
  for (const [rel, body] of Object.entries(FILES)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  symlinkSync("src/a.ts", join(root, "alias.ts"));
  return root;
}
function cli(root: string, ...args: string[]): { json: unknown; stderr: string; status: number | null } {
  const res = spawnSync(process.execPath, [CLI, "scan", "--repo", root, ...args], { encoding: "utf8" });
  return { json: res.status === 0 ? JSON.parse(res.stdout) : undefined, stderr: res.stderr, status: res.status };
}
const why = (root: string, path: string, opts = {}): Omit<PathVerdict, "path"> => {
  const { path: _, ...verdict } = whyPath(root, path, opts);
  return verdict;
};

describe("scan --why", () => {
  const root = fixture();

  it("names the gitignore rule that decided a path: its file, line and pattern", () => {
    expect(why(root, "app.log")).toEqual({
      indexed: false,
      reason: "gitignored",
      detail: { source: ".gitignore", line: 2, pattern: "*.log" },
    });
    expect(why(root, "gen/out.ts")).toEqual({
      indexed: false,
      reason: "gitignored",
      detail: { dir: "gen", source: ".gitignore", line: 4, pattern: "gen/" },
    });
    expect(why(root, "sub/secret.txt").detail).toEqual({ source: "sub/.gitignore", line: 1, pattern: "secret.txt" });
    // A negation re-includes it: indexed, with what the scan makes of it.
    expect(why(root, "keep.log")).toEqual({ indexed: true, reason: null, detail: { kind: "other", lang: "other", size: 5 } });
  });

  it("gives the other walk reasons with what decided them", () => {
    expect(why(root, "src/big.ts", { maxBytes: 100 })).toEqual({
      indexed: false,
      reason: "over-max-bytes",
      detail: { size: FILES["src/big.ts"]!.length, maxBytes: 100 },
    });
    expect(why(root, "src/big.ts").indexed).toBe(true); // the default cap is 1 MiB
    expect(why(root, "node_modules/pkg/index.js")).toEqual({ indexed: false, reason: "ignore-dir", detail: { dir: "node_modules" } });
    expect(why(root, "yarn.lock")).toMatchObject({ reason: "lockfile" });
    expect(why(root, "img.png")).toEqual({ indexed: false, reason: "binary-ext", detail: { ext: ".png" } });
    expect(why(root, "nested/n.ts")).toEqual({ indexed: false, reason: "nested-repo", detail: { dir: "nested" } });
    expect(why(root, "alias.ts")).toEqual({ indexed: false, reason: "file-symlink", detail: { target: "src/a.ts" } });
    expect(why(root, ".git/config")).toMatchObject({ reason: "ignore-dir", detail: { dir: ".git" } });
  });

  it("names the --scope, --include or --exclude that filtered a path out", () => {
    expect(why(root, "tests/t.ts", { scope: "./src" })).toEqual({
      indexed: false,
      reason: "filter",
      detail: { dir: "tests", scope: "./src" },
    });
    expect(why(root, "src/a.ts", { exclude: ["docs/**", "src/**"] }).detail).toEqual({ dir: "src", exclude: "src/**" });
    expect(why(root, "src/a.ts", { include: ["**/*.md"] }).detail).toEqual({ include: ["**/*.md"] });
  });

  it("explains paths the walk never met", () => {
    expect(why(root, "no/such.ts")).toEqual({ indexed: false, reason: "not-found", detail: {} });
    expect(why(root, "node_modules/missing.js").reason).toBe("not-found");
    expect(whyPath(root, "../elsewhere.ts")).toEqual({ path: "../elsewhere.ts", indexed: false, reason: "outside-repo", detail: {} });
    // Spelled as --scope is: absolute inside the repo, or with ./
    expect(whyPath(root, join(root, "src", "a.ts")).path).toBe("src/a.ts");
    expect(whyPath(root, "./src/a.ts")).toMatchObject({ path: "src/a.ts", indexed: true });
    // A directory: how many of its files the scan keeps, and what it skips.
    expect(why(root, "sub")).toEqual({
      indexed: true,
      reason: null,
      detail: { directory: true, files: 2, skipped: { gitignored: 1 } },
    });
    expect(why(root, "gen").reason).toBe("gitignored");
  });

  it("says when --max-files stopped the walk before a file", () => {
    const kept = [".gitignore", "README.md", "keep.log", "src/a.ts", "src/big.ts", "sub/.gitignore", "sub/open.txt", "tests/t.ts"];
    const verdicts = kept.map((rel) => why(root, rel, { maxFiles: 1 }));
    expect(verdicts.filter((v) => v.indexed)).toHaveLength(1);
    for (const v of verdicts.filter((v) => !v.indexed)) expect(v).toEqual({ indexed: false, reason: "max-files", detail: { maxFiles: 1 } });
  });

  it("drives the CLI, index dir included", () => {
    const repo = fixture();
    expect(cli(repo, "--why", "src/big.ts", "--max-bytes", "100").json).toEqual({
      path: "src/big.ts",
      indexed: false,
      reason: "over-max-bytes",
      detail: { size: FILES["src/big.ts"]!.length, maxBytes: 100 },
    });
    const idx = join(repo, "idx");
    expect(spawnSync(process.execPath, [CLI, "index", "--repo", repo, "--out", idx]).status).toBe(0);
    expect(cli(repo, "--why", "idx/graph.json", "--index", "idx").json).toEqual({
      path: "idx/graph.json",
      indexed: false,
      reason: "index-output",
      detail: { out: idx },
    });
    expect(cli(repo, "--why", "src/a.ts", "--skipped").status).not.toBe(0);
  });
});

describe("scan --skipped and the scan summary", () => {
  it("lists every skip once, sorted, and the summary counts the same skips", () => {
    const root = fixture();
    const skipped = cli(root, "--skipped").json as { rel: string; reason: string; directory: boolean }[];
    expect(skipped.map((s) => [s.rel, s.reason])).toEqual([
      ["alias.ts", "file-symlink"],
      ["app.log", "gitignored"],
      ["gen", "gitignored"],
      ["img.png", "binary-ext"],
      ["nested", "nested-repo"],
      ["node_modules", "ignore-dir"],
      ["sub/secret.txt", "gitignored"],
      ["yarn.lock", "lockfile"],
    ]);
    expect(skipped.find((s) => s.rel === "gen")).toMatchObject({ directory: true, rule: { source: ".gitignore", line: 4, pattern: "gen/" } });
    const summary = cli(root).json as { fileCount: number; excluded: number; skipped: Record<string, number> };
    expect(summary.skipped).toEqual({ "binary-ext": 1, "file-symlink": 1, gitignored: 3, "ignore-dir": 1, lockfile: 1, "nested-repo": 1 });
    expect(Object.keys(summary.skipped)).toEqual(Object.keys(summary.skipped).sort());
    // `excluded` keeps its meaning: files the walk rejected, plus nested repos.
    expect(summary.excluded).toBe(5);
    expect(summary.fileCount).toBe(8);
  });
});

describe("gitignore rules remember where they were written", () => {
  it("records source, line and pattern only when a source is named", () => {
    const [rule] = parseGitignore("\n# c\n!docs/*.md  \n", "pkg", "pkg/.gitignore");
    expect([rule!.source, rule!.line, rule!.pattern]).toEqual(["pkg/.gitignore", 3, "!docs/*.md"]);
    expect(Object.keys(parseGitignore("*.log\n", "")[0]!)).not.toContain("source");
  });
});
