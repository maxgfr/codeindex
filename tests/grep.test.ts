// grep: the walk/scope universe, the capped two-phase ripgrep path, the JS
// engine's time budget, and the pattern dialect both backends share. Every
// behavioural assertion runs on BOTH backends (auto = ripgrep when on PATH).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compilePattern, grepRepo, grepRepoEx, toRipgrepRegex, type GrepOptions } from "../src/grep.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

function repo(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-grep2-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

// Runs on both backends, asserts they agree, returns the shared answer.
function both(root: string, pattern: string, opts: GrepOptions = {}) {
  const js = grepRepoEx(root, pattern, { ...opts, noRipgrep: true });
  const auto = grepRepoEx(root, pattern, opts);
  expect(auto.hits).toEqual(js.hits);
  expect(auto.truncated).toBe(js.truncated);
  expect(auto.filesMatched).toBe(js.filesMatched);
  return js;
}
const files = (r: { hits: { file: string }[] }): string[] => [...new Set(r.hits.map((h) => h.file))];

function cli(args: string[], cwd?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("grep universe: walk flags, scope and globs", () => {
  it("honours --ignore-dir, --no-gitignore and --max-bytes like every scanning command", () => {
    const root = repo({
      ".gitignore": "x\n",
      "vendor/lib/x.go": "TARGET\n",
      "build/make.sh": "TARGET\n",
      "src/a.go": "TARGET\n",
      "tmp/notes.txt": "TARGET\n",
      x: "TARGET\n",
      "big.txt": `TARGET ${"y".repeat(100)}\n`,
    });
    expect(files(both(root, "TARGET"))).toEqual(["big.txt", "src/a.go"]);
    // --ignore-dir REPLACES the default set (.git stays skipped).
    expect(files(both(root, "TARGET", { ignoreDirs: [".git"] }))).toEqual([
      "big.txt",
      "build/make.sh",
      "src/a.go",
      "tmp/notes.txt",
      "vendor/lib/x.go",
    ]);
    expect(files(both(root, "TARGET", { gitignore: false }))).toEqual(["big.txt", "src/a.go", "x"]);
    expect(files(both(root, "TARGET", { maxFileBytes: 50 }))).toEqual(["src/a.go"]);
    const out = cli(["grep", "TARGET", "--repo", root, "--ignore-dir", ".git", "--no-gitignore", "--max-bytes", "50"]);
    expect((JSON.parse(out.stdout) as { file: string }[]).map((h) => h.file)).toEqual([
      "build/make.sh",
      "src/a.go",
      "tmp/notes.txt",
      "vendor/lib/x.go",
      "x",
    ]);
  });

  it("honours .git/info/exclude on both backends, as the walker does", () => {
    const root = repo({ "kept.txt": "NEEDLE\n", "local.txt": "NEEDLE\n" });
    execFileSync("git", ["init", "-q", "."], { cwd: root });
    writeFileSync(join(root, ".git", "info", "exclude"), "local.txt\n");
    expect(files(both(root, "NEEDLE"))).toEqual(["kept.txt"]);
    expect(files(both(root, "NEEDLE", { gitignore: false }))).toEqual(["kept.txt", "local.txt"]);
  });

  it("never lets a positive glob resurrect ignored files (an rg whitelist glob overrides ignores)", () => {
    const root = repo({
      ".gitignore": "gen.ts\n",
      "src/a.ts": "NEEDLE\n",
      "src/gen.ts": "NEEDLE\n",
      "src/node_modules/m/i.ts": "NEEDLE\n",
    });
    expect(files(both(root, "NEEDLE", { globs: ["src/**"] }))).toEqual(["src/a.ts"]);
    expect(files(both(root, "NEEDLE", { globs: ["**/*.ts"] }))).toEqual(["src/a.ts"]);
  });

  it("never searches the engine's own .codeindex, whatever --ignore-dir says", () => {
    const root = repo({ "a.txt": "NEEDLE\n", ".codeindex/memories/n.md": "NEEDLE\n", "vendor/v.txt": "NEEDLE\n" });
    expect(files(both(root, "NEEDLE"))).toEqual(["a.txt"]);
    expect(files(both(root, "NEEDLE", { ignoreDirs: ["vendor"] }))).toEqual(["a.txt"]);
  });

  it("hands rg only the exclusions both glob dialects read alike", () => {
    const root = repo({ "sub/a.txt": "NEEDLE\n", "a.txt": "NEEDLE\n", "gen/g.txt": "NEEDLE\n" });
    // `!sub` names a path, not a tree; `{a,b}` is not alternation here.
    expect(files(both(root, "NEEDLE", { globs: ["!sub", "!{a,b}.txt"] }))).toEqual(["a.txt", "gen/g.txt", "sub/a.txt"]);
    expect(files(both(root, "NEEDLE", { globs: ["!gen/**"] }))).toEqual(["a.txt", "sub/a.txt"]);
  });

  it("ANDs scope with globs, and a scope may be a file or a ./ or absolute spelling", () => {
    const root = repo({
      "binding/a.go": "Default\n",
      "binding/b_test.go": "Default\n",
      "binding/doc.md": "Default\n",
      "README.md": "Default\n",
      "gin.go": "Default\n",
    });
    expect(files(both(root, "Default", { scope: "binding", globs: ["**/*.md"] }))).toEqual(["binding/doc.md"]);
    expect(files(both(root, "Default", { scope: "binding", globs: ["!**/*_test.go"] }))).toEqual(["binding/a.go", "binding/doc.md"]);
    expect(files(both(root, "Default", { scope: "gin.go" }))).toEqual(["gin.go"]);
    expect(files(both(root, "Default", { scope: "./binding/" }))).toEqual(["binding/a.go", "binding/b_test.go", "binding/doc.md"]);
    expect(files(both(root, "Default", { scope: join(root, "binding") }))).toEqual(["binding/a.go", "binding/b_test.go", "binding/doc.md"]);
    expect(() => grepRepo(root, "Default", { scope: tmpdir() })).toThrow(/outside the repository/);
    // The scan's normalizeScope: backslashes and `..` segments read as the
    // walk reads them, and a relative escape is refused like an absolute one.
    expect(files(both(root, "Default", { scope: "binding\\" }))).toEqual(["binding/a.go", "binding/b_test.go", "binding/doc.md"]);
    expect(files(both(root, "Default", { scope: "binding/../gin.go" }))).toEqual(["gin.go"]);
    expect(() => grepRepo(root, "Default", { scope: "../elsewhere" })).toThrow(/outside the repository/);
    // The CLI and the MCP tool thread scope the same way.
    const out = cli(["grep", "Default", "--repo", root, "--scope", "binding", "--include", "**/*.md"]);
    expect((JSON.parse(out.stdout) as { file: string }[]).map((h) => h.file)).toEqual(["binding/doc.md"]);
    const mcp = mcpCall({ name: "grep", arguments: { repo: root, pattern: "Default", scope: "binding", globs: ["**/*.md"] } });
    expect((JSON.parse(mcp) as { file: string }[]).map((h) => h.file)).toEqual(["binding/doc.md"]);
  });
});

describe("grep CLI end of options", () => {
  it("`grep -- --out` searches for --out and writes no file", () => {
    const root = repo({ "src/a.txt": "run with --out here\n" });
    const cwd = mkdtempSync(join(tmpdir(), "ci-grep-cwd-"));
    const out = cli(["grep", "--repo", root, "--", "--out", "--scope", "src"], cwd);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([{ file: "src/a.txt", line: 1, col: 10, text: "run with --out here" }]);
    expect(readdirSync(cwd)).toEqual([]);
    expect(cli(["grep", "x", "--", "y", "--repo", root]).stderr).toMatch(/unexpected "--"/);
  });
});

describe("grep cap: truncation is reported, never silent", () => {
  const root = (): string => repo({ "a.txt": "hit\nhit\n", "b.txt": "hit\n", "c.txt": "miss\n" });

  it("reports truncated + filesMatched identically on both backends", () => {
    const r = both(root(), "hit", { maxHits: 2 });
    expect(r.hits.map((h) => `${h.file}:${h.line}`)).toEqual(["a.txt:1", "a.txt:2"]);
    expect(r).toMatchObject({ truncated: true, filesMatched: 2, timedOut: false });
    expect(r.notes.join("\n")).toMatch(/first 2 hits .*2 files match/);
    // Exactly at the cap is complete, not truncated.
    expect(both(root(), "hit", { maxHits: 3 })).toMatchObject({ truncated: false, filesMatched: 2, notes: [] });
  });

  it("keeps stdout the bare array and says so on stderr; MCP opts into the envelope", () => {
    const dir = root();
    const out = cli(["grep", "hit", "--repo", dir, "--max-hits", "1"]);
    expect(JSON.parse(out.stdout)).toHaveLength(1);
    expect(out.stderr).toMatch(/^codeindex grep: showing the first 1 hits .*2 files match/m);
    expect(cli(["grep", "hit", "--repo", dir]).stderr).toBe("");
    const bare = JSON.parse(mcpCall({ name: "grep", arguments: { repo: dir, pattern: "hit", maxHits: 1 } }));
    expect(Array.isArray(bare)).toBe(true);
    const meta = JSON.parse(mcpCall({ name: "grep", arguments: { repo: dir, pattern: "hit", maxHits: 1, withMeta: true } }));
    expect(meta).toMatchObject({ truncated: true, filesMatched: 2 });
    expect(meta.hits).toHaveLength(1);
  });

  it("filesWithMatches returns each matching file's first hit and caps files", () => {
    const r = both(root(), "hit", { filesWithMatches: true });
    expect(r.hits.map((h) => `${h.file}:${h.line}`)).toEqual(["a.txt:1", "b.txt:1"]);
    expect(r).toMatchObject({ truncated: false, filesMatched: 2 });
    const capped = both(root(), "hit", { filesWithMatches: true, maxHits: 1 });
    expect(capped.hits.map((h) => h.file)).toEqual(["a.txt"]);
    expect(capped.truncated).toBe(true);
    expect(capped.notes.join("\n")).toMatch(/first 1 matching files by path; 2 files match/);
    const out = cli(["grep", "hit", "--repo", root(), "--files-with-matches"]);
    expect((JSON.parse(out.stdout) as { file: string }[]).map((h) => h.file)).toEqual(["a.txt", "b.txt"]);
  });

  it("cuts a huge line to a window around the match and reports its column", () => {
    const line = `${"x".repeat(5000)}NEEDLE${"y".repeat(5000)}`;
    const r = both(repo({ "min.js": `${line}\n` }), "NEEDLE");
    const [hit] = r.hits;
    expect(hit!.col).toBe(5001);
    expect(hit!.text.length).toBeLessThanOrEqual(302);
    expect(hit!.text).toMatch(/^…x+NEEDLEy+…$/);
  });

  it("counts columns in UTF-16 units on both backends", () => {
    const r = both(repo({ "u.txt": "é😀 NEEDLE\n" }), "NEEDLE");
    expect(r.hits[0]!.col).toBe(5);
  });
});

describe("grep JS engine time budget", () => {
  it("stops a catastrophic pattern at the budget and reports the partial result", () => {
    const root = repo({ "a.txt": "aab\n", "b-evil.txt": `${"a".repeat(40)}!\n`, "c.txt": "aab\n" });
    const t = Date.now();
    // A backreference: ripgrep cannot run it, so the JS engine does.
    const r = grepRepoEx(root, "(a+)+\\1b", { timeoutMs: 300 });
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.timedOut).toBe(true);
    expect(r.hits.map((h) => h.file)).toEqual(["a.txt"]);
    expect(r.notes.join("\n")).toMatch(/300 ms budget in b-evil\.txt: hits cover only the 1 file before it/);

    const out = cli(["grep", "(a+)+\\1b", "--repo", root, "--timeout-ms", "300"]);
    expect(out.status).toBe(0);
    expect((JSON.parse(out.stdout) as { file: string }[]).map((h) => h.file)).toEqual(["a.txt"]);
    expect(out.stderr).toMatch(/codeindex grep: the JavaScript regex engine ran out of its 300 ms budget in b-evil\.txt/);
    const mcp = JSON.parse(mcpCall({ name: "grep", arguments: { repo: root, pattern: "(a+)+\\1b", timeoutMs: 300 } }));
    expect(mcp).toMatchObject({ timedOut: true, hits: [{ file: "a.txt" }] });
  });

  it("says why the slower engine ran", () => {
    const root = repo({ "a.txt": "aa\n" });
    const r = grepRepoEx(root, "(a)\\1");
    expect(r.hits).toHaveLength(1);
    if (grepRepoEx(root, "a").notes.length === 0) {
      // ripgrep present (no note on a plain pattern): the fallback is named.
      expect(r.notes.join("\n")).toMatch(/JavaScript-only syntax.*slower JavaScript engine/);
    }
  });
});

describe("grep dialect: one meaning on both backends", () => {
  const root = (): string =>
    repo({
      "u.txt": "héllo wörld\nfunction foo() {\nsay \"hi\"\n",
      "crlf.txt": "fooX\r\nbar\r\n",
      "nl.txt": "a\n\nb\n",
      "l1.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), // "café" in latin-1
    });

  it.each([
    ["\\p{L}+ld", ["u.txt:1"]], // Unicode property: u flag in JS, native in rg
    ["\\bw\\w+ld\\b", []], // \w \b are ASCII in JS — rg is pinned to that
    ["w\\w+ld", []],
    ["foo\\(\\) \\{", ["u.txt:2"]],
    ["foo\\(\\) {", ["u.txt:2"]], // legacy-dialect literal `{` (a Rust syntax error)
    ['say \\"hi\\"', ["u.txt:3"]],
    ["^$", ["nl.txt:2"]], // no phantom empty line after the final newline
    ["fooX.$", []], // JS `.` does not cross \r; Rust's would
    ["caf", ["l1.txt:1"]],
    ["café", []], // invalid UTF-8 reads as U+FFFD on both, not as latin-1
  ])("%s", (pattern, expected) => {
    expect(both(root(), pattern).hits.map((h) => `${h.file}:${h.line}`)).toEqual(expected);
  });

  it.each([
    ["\\Aneedle", /`\\A` is not JavaScript regex syntax.*use \^/],
    ["needle\\z", /`\\z`/],
    ["[[:alpha:]]+ld", /POSIX classes/],
    ["\\x{65}", /`\\x\{`/],
    ["[a-z&&[^b]]", /set syntax/],
  ])("refuses foreign syntax %s instead of reading it as a literal", (pattern, why) => {
    expect(() => compilePattern(pattern)).toThrow(why);
    expect(() => grepRepo(root(), pattern)).toThrow(why);
  });

  it("translates to ripgrep only what keeps its meaning", () => {
    expect(toRipgrepRegex(compilePattern("\\w+\\b[\\d-]"))).toBe("(?-u:\\w)+(?-u:\\b)[[:digit:]-]");
    expect(toRipgrepRegex(compilePattern("a{2}b{"))).toBe("a{2}b\\{");
    expect(toRipgrepRegex(compilePattern("(?<=a)b"))).toBeUndefined();
    expect(toRipgrepRegex(compilePattern("(a)\\1"))).toBeUndefined();
    expect(toRipgrepRegex(compilePattern("[]a]"))).toBeUndefined();
  });

  it("still throws the familiar error on an invalid pattern, on both backends", () => {
    expect(() => grepRepo(root(), "unclosed(", { noRipgrep: true })).toThrow(/Invalid regular expression/);
    expect(() => grepRepo(root(), "unclosed(")).toThrow(/Invalid regular expression/);
  });
});

// One MCP tools/call through the bundled server; returns the tool's text.
function mcpCall(params: Record<string, unknown>): string {
  const input =
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params },
    ]
      .map((m) => JSON.stringify(m))
      .join("\n") + "\n";
  const out = execFileSync(process.execPath, [CLI, "mcp"], { input, encoding: "utf8", timeout: 20_000 });
  const msg = out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id?: number; result?: { content: { text: string }[]; isError?: boolean } })
    .find((m) => m.id === 2)!;
  if (msg.result?.isError) throw new Error(msg.result.content[0]!.text);
  return msg.result!.content[0]!.text;
}
