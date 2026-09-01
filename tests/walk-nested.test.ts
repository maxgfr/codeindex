// Repository boundaries in the walker: `.git` is never walked, nested repos
// (linked worktrees, vendored clones, submodules) are skipped like git does,
// and `.git/info/exclude` is honored. Fixtures are built in a temp dir because
// git refuses to track a path named `.git`.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { walk } from "../src/walk.js";

const GIT = ".git";
const body = "export const a = 1;\n";

function mkfile(root: string, rel: string, content = body): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

// A plain clone: `.git` is a directory holding info/exclude.
function cloneFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ci-nested-"));
  mkfile(root, "src/main.ts");
  mkfile(root, "src/local-notes.ts");
  mkfile(root, "scratch/keep.ts");
  mkfile(root, "scratch/drop.ts");
  mkfile(root, `${GIT}/HEAD`, "ref: refs/heads/main\n");
  mkfile(root, `${GIT}/objects/ab/cdef`, "loose object\n");
  // `scratch/*` (not `scratch/`): an ignored DIRECTORY is never descended, so
  // only a file-level rule can be negated back — same as git.
  mkfile(root, `${GIT}/info/exclude`, "# local junk\nsrc/local-notes.ts\nscratch/*\n!scratch/keep.ts\n");
  return root;
}

const rels = (root: string, opts?: Parameters<typeof walk>[1]) => walk(root, opts).files.map((f) => f.rel).sort();

describe("walk stops at nested repository boundaries", () => {
  it("skips a subdirectory carrying a gitfile (linked worktree / submodule)", () => {
    const root = cloneFixture();
    mkfile(root, ".claude/worktrees/feature/src/main.ts");
    mkfile(root, `.claude/worktrees/feature/${GIT}`, `gitdir: ${join(root, GIT, "worktrees", "feature")}\n`);
    mkfile(root, ".claude/skills/note.md", "# note\n");
    const walked = walk(root);
    const files = walked.files.map((f) => f.rel).sort();
    expect(files).toEqual([".claude/skills/note.md", "scratch/keep.ts", "src/main.ts"]);
    expect(files.some((r) => r.startsWith(".claude/worktrees/"))).toBe(false);
    // The boundary is counted as one exclusion so consumers can report it —
    // on top of the two files info/exclude dropped.
    expect(walked.excluded).toBe(3);
  });

  it("skips a subdirectory carrying its own .git DIRECTORY (vendored clone)", () => {
    const root = cloneFixture();
    mkfile(root, "third_party/lib/index.ts");
    mkfile(root, `third_party/lib/${GIT}/HEAD`, "ref: refs/heads/main\n");
    mkfile(root, "third_party/own.ts");
    expect(rels(root)).toEqual(["scratch/keep.ts", "src/main.ts", "third_party/own.ts"]);
  });

  it("the boundary is structural: gitignore:false still stops at it", () => {
    const root = cloneFixture();
    mkfile(root, "vendored/app/x.ts");
    mkfile(root, `vendored/app/${GIT}`, "gitdir: /nowhere\n");
    const files = rels(root, { gitignore: false });
    expect(files).not.toContain("vendored/app/x.ts");
    // …while info/exclude, part of the gitignore layer, is disabled.
    expect(files).toContain("src/local-notes.ts");
    expect(files).toContain("scratch/drop.ts");
  });
});

describe("walk honors .git/info/exclude", () => {
  it("applies its rules, including negation, before the .gitignore chain", () => {
    const root = cloneFixture();
    expect(rels(root)).toEqual(["scratch/keep.ts", "src/main.ts"]);
  });

  it("a later .gitignore rule can re-include what info/exclude dropped", () => {
    const root = cloneFixture();
    mkfile(root, ".gitignore", "!src/local-notes.ts\n");
    expect(rels(root)).toEqual([".gitignore", "scratch/keep.ts", "src/local-notes.ts", "src/main.ts"]);
  });

  it("follows a gitfile to the linked worktree's common dir", () => {
    // Layout of `git worktree add`: <wt>/.git → "gitdir: <main>/.git/worktrees/<name>",
    // whose `commondir` file points back at <main>/.git where info/ lives.
    const main = mkdtempSync(join(tmpdir(), "ci-wt-main-"));
    mkfile(main, `${GIT}/info/exclude`, "*.local.ts\n");
    mkfile(main, `${GIT}/worktrees/feat/commondir`, "../..\n");
    const wt = mkdtempSync(join(tmpdir(), "ci-wt-"));
    mkfile(wt, "a.ts");
    mkfile(wt, "a.local.ts");
    writeFileSync(join(wt, GIT), `gitdir: ${join(main, GIT, "worktrees", "feat")}\n`);
    expect(rels(wt)).toEqual(["a.ts"]);
  });

  it("a gitfile at the root is not indexed as a source file", () => {
    const wt = mkdtempSync(join(tmpdir(), "ci-gitfile-"));
    mkfile(wt, "a.ts");
    writeFileSync(join(wt, GIT), "gitdir: /nowhere\n");
    expect(rels(wt)).toEqual(["a.ts"]);
    expect(rels(wt, { gitignore: false })).toEqual(["a.ts"]);
  });
});

describe(".git is skipped whatever ignoreDirs says", () => {
  it("--ignore-dir replacing the default list does not pull .git/objects in", () => {
    const root = cloneFixture();
    mkfile(root, "generated/x.ts");
    const files = rels(root, { ignoreDirs: ["generated"] });
    expect(files).toEqual(["scratch/keep.ts", "src/main.ts"]);
    expect(files.some((r) => r.startsWith(`${GIT}/`))).toBe(false);
  });

  it("an empty replacement list still skips .git", () => {
    const root = cloneFixture();
    expect(rels(root, { ignoreDirs: [], gitignore: false }).some((r) => r.startsWith(`${GIT}/`))).toBe(false);
  });
});
