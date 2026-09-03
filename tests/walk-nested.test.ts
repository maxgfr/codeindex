// Repository boundaries in the walker: `.git` is never walked, nested repos
// (linked worktrees, vendored clones, submodules) are skipped like git does,
// and `.git/info/exclude` is honored. Fixtures are built in a temp dir because
// git refuses to track a path named `.git`.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

// The boundary must be a REPOSITORY, not merely the name `.git`. Git accepts a
// `.git` FILE only when it reads "gitdir: <path>" and rejects anything else
// ("fatal: invalid gitfile format"); treating such a file as a repo silently
// dropped its whole subtree from the index.
describe("only a VALID .git marker is a repository boundary", () => {
  // Every body here is rejected by real git as "invalid gitfile format" — the
  // prefix must be exactly `gitdir: `, at the very start (verified against git).
  const invalid = [
    "not a gitfile at all\n",
    "",
    "gitdir\n",
    "# gitdir: x\n",
    "gitdir:/nowhere\n", // no space after the colon
    "  gitdir: /nowhere\n", // leading whitespace
    "junk\ngitdir: /nowhere\n", // not the first line
    "gitdir: \n", // prefix but no path
  ];

  it("keeps the subtree when the .git file is not a gitfile", () => {
    for (const body of invalid) {
      const root = mkdtempSync(join(tmpdir(), "ci-badgit-"));
      mkfile(root, "top.ts");
      mkfile(root, "sub/kept.ts");
      mkfile(root, `sub/${GIT}`, body);
      expect(rels(root), JSON.stringify(body)).toEqual(["sub/kept.ts", "top.ts"]);
      // The bogus marker itself is still never indexed as a source file, and
      // nothing was counted as an excluded repository boundary.
      expect(walk(root).excluded, JSON.stringify(body)).toBe(0);
    }
  });

  it("still stops at a valid gitfile beside an invalid one", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-mixedgit-"));
    mkfile(root, "top.ts");
    mkfile(root, "bogus/kept.ts");
    mkfile(root, `bogus/${GIT}`, "junk\n");
    mkfile(root, "real/hidden.ts");
    mkfile(root, `real/${GIT}`, "gitdir: /nowhere\n");
    const walked = walk(root);
    expect(walked.files.map((f) => f.rel).sort()).toEqual(["bogus/kept.ts", "top.ts"]);
    expect(walked.excluded).toBe(1);
  });

  it("a directory named .git is a boundary whatever it contains", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-gitdir-"));
    mkfile(root, "top.ts");
    mkfile(root, "clone/inner.ts");
    mkfile(root, `clone/${GIT}/HEAD`, "ref: refs/heads/main\n");
    expect(rels(root)).toEqual(["top.ts"]);
  });

  it("a gitfile without a trailing newline is still a marker", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-nonl-"));
    mkfile(root, "top.ts");
    mkfile(root, "wt/inner.ts");
    mkfile(root, `wt/${GIT}`, "gitdir: /nowhere"); // git accepts this
    expect(rels(root)).toEqual(["top.ts"]);
  });

  // `.git` may legitimately be a symlink; the dirent of a link is neither file
  // nor directory, so the target has to decide.
  it("resolves a symlinked .git through its target, and ignores a broken one", () => {
    // Targets live OUTSIDE the walked tree, so only the boundary decisions show.
    const store = mkdtempSync(join(tmpdir(), "ci-gitlink-store-"));
    mkfile(store, "gitdir/HEAD", "ref: refs/heads/main\n");
    mkfile(store, "pointer", "gitdir: /nowhere\n");
    const root = mkdtempSync(join(tmpdir(), "ci-gitlink-"));
    mkfile(root, "top.ts");
    // Symlink to a git DIRECTORY → boundary.
    mkfile(root, "linked/inner.ts");
    symlinkSync(join(store, "gitdir"), join(root, "linked", GIT));
    // Symlink to a valid gitFILE → boundary.
    mkfile(root, "linkfile/inner.ts");
    symlinkSync(join(store, "pointer"), join(root, "linkfile", GIT));
    // Dangling symlink → NOT a repository, so the subtree is kept.
    mkfile(root, "broken/kept.ts");
    symlinkSync(join(root, "gone"), join(root, "broken", GIT));
    expect(rels(root)).toEqual(["broken/kept.ts", "top.ts"]);
  });

  // The cap is only observable on a marker that WOULD otherwise parse: a
  // garbage file is kept either way, so asserting on one proves nothing about
  // reading. An oversized but well-formed gitfile is the case the cap decides.
  it("ignores a marker too large to be a gitfile, and keeps its subtree", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-biggit-"));
    mkfile(root, "top.ts");
    mkfile(root, "sub/kept.ts");
    mkfile(root, `sub/${GIT}`, "gitdir: /nowhere" + "\n".repeat(5000));
    expect(rels(root)).toEqual(["sub/kept.ts", "top.ts"]);
    // …while the same body under the cap IS a marker.
    const small = mkdtempSync(join(tmpdir(), "ci-smallgit-"));
    mkfile(small, "top.ts");
    mkfile(small, "sub/inner.ts");
    mkfile(small, `sub/${GIT}`, "gitdir: /nowhere" + "\n".repeat(100));
    expect(rels(small)).toEqual(["top.ts"]);
  });

  // Git trims exactly `\n`/`\r` from a gitfile's path — never spaces or tabs.
  // A git directory whose NAME ends in a space is therefore reachable, and
  // trimming whitespace resolved it to a different directory whose
  // `info/exclude` was never found.
  it("keeps trailing spaces in the gitdir path, as git does", () => {
    const store = mkdtempSync(join(tmpdir(), "ci-spacegit-")) + "/store ";
    mkfile(store, "info/exclude", "dropped.ts\n");
    const root = mkdtempSync(join(tmpdir(), "ci-spaceroot-"));
    mkfile(root, "kept.ts");
    mkfile(root, "dropped.ts");
    writeFileSync(join(root, GIT), `gitdir: ${store}\n`);
    expect(rels(root)).toEqual(["kept.ts"]);
  });
});
