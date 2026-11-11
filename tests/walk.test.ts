import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { scanRepo } from "../src/scan.js";
import { isInside, walk, type WalkSkip } from "../src/walk.js";

function tree(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ci-walk-"));
  for (const rel of files) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), "x\n");
  }
  return root;
}

describe("walk order", () => {
  it("lists a directory's files, then its subdirectories in name order", () => {
    const root = tree(["z.ts", "c/1.ts", "a/1.ts", "b/1.ts", "a/sub/2.ts", "a/0.ts"]);
    expect(walk(root).files.map((f) => f.rel)).toEqual(["z.ts", "a/0.ts", "a/1.ts", "a/sub/2.ts", "b/1.ts", "c/1.ts"]);
  });

  it("a --max-files cap keeps the beginning of the alphabet", () => {
    const root = tree(["z.ts", "c/1.ts", "a/1.ts", "b/1.ts"]);
    const res = walk(root, { maxFiles: 2 });
    expect(res.files.map((f) => f.rel)).toEqual(["z.ts", "a/1.ts"]);
    expect(res.capped).toBe(true);
  });
});

// Permissions cannot hide anything from root, and Windows has no chmod to speak of.
const canLock = process.platform !== "win32" && process.getuid?.() !== 0;

describe("what cannot be read is said, not dropped", () => {
  it.runIf(canLock)("a directory that cannot be listed is reported as skipped", () => {
    const root = tree(["a.ts", "locked/inside.ts", "open/b.ts"]);
    chmodSync(join(root, "locked"), 0o000);
    try {
      const skipped: WalkSkip[] = [];
      const res = walk(root, { onSkip: (s) => skipped.push(s) });
      expect(res.files.map((f) => f.rel)).toEqual(["a.ts", "open/b.ts"]);
      expect(skipped).toEqual([{ rel: "locked", reason: "unreadable", directory: true }]);
    } finally {
      chmodSync(join(root, "locked"), 0o755);
    }
  });

  it.runIf(canLock)("a file that cannot be read is skipped by the walk itself, counted nowhere, indexed once it can be", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-walk-unreadable-"));
    writeFileSync(join(root, "ok.ts"), "export const ok = 1;\n");
    writeFileSync(join(root, "secret.py"), "def hidden():\n    return 1\n");
    chmodSync(join(root, "secret.py"), 0o000);
    const skipped: { rel: string; reason: string }[] = [];
    let first;
    let walked;
    try {
      walked = walk(root).files.map((f) => f.rel);
      first = scanRepo(root, { onSkip: (s) => skipped.push({ rel: s.rel, reason: s.reason }) });
    } finally {
      chmodSync(join(root, "secret.py"), 0o644);
    }
    // The walk, which the freshness proof and `status` also read, leaves it
    // out: they and the scan agree on the file set.
    expect(walked).toEqual(["ok.ts"]);
    // Not an empty file of the index, nor a language with no file in it.
    expect(first.files.map((f) => f.rel)).toEqual(["ok.ts"]);
    expect(first.languages).toEqual({ typescript: 1 });
    expect(skipped).toEqual([{ rel: "secret.py", reason: "unreadable" }]);

    // chmod moved its ctime, not its mtime. A scan seeded with the first one's
    // records, stat keys included, must still read it now.
    const cache = new Map(first.files.map((f) => [f.rel, { hash: f.hash, record: f, size: f.size, mtimeMs: first.mtimes.get(f.rel)! }]));
    const second = scanRepo(root, { cache });
    expect(second.files.map((f) => f.rel)).toEqual(["ok.ts", "secret.py"]);
    expect(second.files[1]!.symbols.map((s) => s.name)).toEqual(["hidden"]);
    expect(second.contentUnchanged).toBe(false);
  });

  it("containment holds for a repository indexed from the root of a filesystem", () => {
    expect(isInside(sep, join(sep, "srv", "repo"))).toBe(true);
    expect(isInside(sep, sep)).toBe(true);
    expect(isInside(join(sep, "srv", "repo"), join(sep, "srv", "repo", "a.ts"))).toBe(true);
    expect(isInside(join(sep, "srv", "repo"), join(sep, "srv", "repo"))).toBe(true);
    // A sibling whose name merely starts with the root's is outside.
    expect(isInside(join(sep, "srv", "repo"), join(sep, "srv", "repo-other", "a.ts"))).toBe(false);
    expect(isInside(join(sep, "srv", "repo"), join(sep, "srv"))).toBe(false);
  });
});
