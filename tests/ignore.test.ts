import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGitignore, isIgnored } from "../src/ignore.js";
import { walk } from "../src/walk.js";
import { scanRepo } from "../src/scan.js";

const test = (rules: ReturnType<typeof parseGitignore>, rel: string, isDir = false) =>
  isIgnored(rules, rel, isDir);

describe("parseGitignore semantics", () => {
  it("floating patterns match at any depth; blank lines and comments are dropped", () => {
    const r = parseGitignore("# build junk\n\n*.log\ntemp\n", "");
    expect(test(r, "a.log")).toBe(true);
    expect(test(r, "deep/nested/b.log")).toBe(true);
    expect(test(r, "temp")).toBe(true);
    expect(test(r, "src/temp", true)).toBe(true);
    expect(test(r, "src/temperature.ts")).toBe(false);
  });

  it("a slash anchors to the .gitignore's directory", () => {
    const r = parseGitignore("/secret.txt\ndocs/private.md\n", "");
    expect(test(r, "secret.txt")).toBe(true);
    expect(test(r, "sub/secret.txt")).toBe(false); // anchored — no float
    expect(test(r, "docs/private.md")).toBe(true);
    expect(test(r, "x/docs/private.md")).toBe(false);
  });

  it("trailing slash restricts to directories", () => {
    const r = parseGitignore("build/\n", "");
    expect(test(r, "build", true)).toBe(true);
    expect(test(r, "build")).toBe(false); // a FILE named build is not matched
  });

  it("negation re-includes, last match wins", () => {
    const r = parseGitignore("*.log\n!keep.log\n", "");
    expect(test(r, "debug.log")).toBe(true);
    expect(test(r, "keep.log")).toBe(false);
    expect(test(r, "sub/keep.log")).toBe(false);
  });

  it("** crosses segments; * and ? stay within one", () => {
    const r = parseGitignore("a/**/z.txt\nlib/*.js\nfile?.md\n", "");
    expect(test(r, "a/z.txt")).toBe(true);
    expect(test(r, "a/b/c/z.txt")).toBe(true);
    expect(test(r, "lib/x.js")).toBe(true);
    expect(test(r, "lib/sub/x.js")).toBe(false);
    expect(test(r, "file1.md")).toBe(true);
    expect(test(r, "file12.md")).toBe(false);
  });

  it("trims only unescaped trailing SPACES (git semantics)", () => {
    // Trailing tab is significant; escaped trailing space is literal.
    const r = parseGitignore("ghi\t\ndef\\ \nplain   \n", "");
    expect(test(r, "ghi\t")).toBe(true);
    expect(test(r, "ghi")).toBe(false);
    expect(test(r, "def ")).toBe(true);
    expect(test(r, "def")).toBe(false);
    expect(test(r, "plain")).toBe(true);
  });

  it("consumes fnmatch escapes mid-pattern", () => {
    const r = parseGitignore("a\\*b\n\\#lit\n\\!bang\n", "");
    expect(test(r, "a*b")).toBe(true);
    expect(test(r, "axb")).toBe(false); // escaped star is literal, not a wildcard
    expect(test(r, "#lit")).toBe(true);
    expect(test(r, "!bang")).toBe(true);
  });

  it("supports [...] character classes", () => {
    const r = parseGitignore("*.py[co]\n[Tt]humbs.db\n", "");
    expect(test(r, "m.pyc")).toBe(true);
    expect(test(r, "m.pyo")).toBe(true);
    expect(test(r, "m.py")).toBe(false);
    expect(test(r, "Thumbs.db")).toBe(true);
    expect(test(r, "thumbs.db")).toBe(true);
    // A file literally named with brackets must NOT match the class pattern.
    expect(test(r, "x.py[co]")).toBe(false);
  });

  it("nested .gitignore rules are scoped to their base directory", () => {
    const r = parseGitignore("*.gen.ts\n", "packages/core");
    expect(test(r, "packages/core/x.gen.ts")).toBe(true);
    expect(test(r, "packages/core/deep/y.gen.ts")).toBe(true);
    expect(test(r, "packages/other/x.gen.ts")).toBe(false);
    expect(test(r, "x.gen.ts")).toBe(false);
  });
});

describe("walk honors .gitignore", () => {
  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "ci-ignore-"));
    writeFileSync(join(root, ".gitignore"), "artifacts/\n*.log\n/secret.txt\n!keep.log\n");
    writeFileSync(join(root, "main.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "debug.log"), "x\n");
    writeFileSync(join(root, "keep.log"), "x\n");
    writeFileSync(join(root, "secret.txt"), "x\n");
    mkdirSync(join(root, "artifacts"));
    writeFileSync(join(root, "artifacts", "bundle.js"), "x\n");
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "pkg", ".gitignore"), "generated/\nlocal.txt\n");
    writeFileSync(join(root, "pkg", "index.ts"), "export const b = 2;\n");
    writeFileSync(join(root, "pkg", "local.txt"), "x\n");
    writeFileSync(join(root, "pkg", "secret.txt"), "not-anchored-here\n");
    mkdirSync(join(root, "pkg", "generated"));
    writeFileSync(join(root, "pkg", "generated", "api.ts"), "x\n");
    return root;
  }

  it("applies root and nested rules with anchoring and negation", () => {
    const rels = walk(fixture())
      .files.map((f) => f.rel)
      .sort();
    expect(rels).toEqual([".gitignore", "keep.log", "main.ts", "pkg/.gitignore", "pkg/index.ts", "pkg/secret.txt"]);
  });

  it("gitignore: false disables the whole layer", () => {
    const rels = walk(fixture(), { gitignore: false })
      .files.map((f) => f.rel)
      .sort();
    expect(rels).toContain("debug.log");
    expect(rels).toContain("artifacts/bundle.js");
    expect(rels).toContain("pkg/generated/api.ts");
    expect(rels).toContain("secret.txt");
  });

  it("scanRepo scope sugar restricts to one directory", () => {
    const scan = scanRepo(fixture(), { scope: "pkg" });
    const rels = scan.files.map((f) => f.rel);
    expect(rels).toContain("pkg/index.ts");
    expect(rels.every((r) => r.startsWith("pkg/"))).toBe(true);
  });
});

describe("symlink-escape guard", () => {
  it("skips file and directory symlinks whose real path leaves the repo", () => {
    const outside = mkdtempSync(join(tmpdir(), "ci-outside-"));
    writeFileSync(join(outside, "leaked.txt"), "outside\n");
    const root = mkdtempSync(join(tmpdir(), "ci-symlink-"));
    writeFileSync(join(root, "inside.ts"), "export const a = 1;\n");
    symlinkSync(join(outside, "leaked.txt"), join(root, "escape.txt"));
    symlinkSync(outside, join(root, "escape-dir"));

    const rels = walk(root).files.map((f) => f.rel);
    expect(rels).toEqual(["inside.ts"]);
  });

  it("keeps symlinks that stay inside the repo", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-symlink-in-"));
    writeFileSync(join(root, "real.ts"), "export const a = 1;\n");
    symlinkSync(join(root, "real.ts"), join(root, "alias.ts"));
    const rels = walk(root)
      .files.map((f) => f.rel)
      .sort();
    expect(rels).toEqual(["alias.ts", "real.ts"]);
  });
});
