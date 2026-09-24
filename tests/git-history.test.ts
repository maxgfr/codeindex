// Git-history analytics (churn) and the diff plumbing behind `delta`, against
// real temporary repositories: --repo below the git toplevel, hostile user
// config, shallow clones, since windows and the history memo.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedSince, diffFiles, diffHunks, gitChurn } from "../src/git.js";

// Commits are made with signing off and a fixed identity so the fixture does
// not depend on the machine's git config; the code under test still runs
// with whatever config the repository itself carries.
function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env },
  });
}

function newRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ["init", "-q"]);
  return root;
}

// One commit writing `files` (rel → content); `date` pins author+committer dates.
function commit(root: string, files: Record<string, string>, date?: string): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "c"], date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {});
}

let tick = 0;
const bump = (): string => `// ${++tick}\n`;

function sorted(churn: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...churn].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

describe("history below the git toplevel (--repo is one package of a monorepo)", () => {
  function monorepo(): string {
    const root = newRepo("ci-hist-mono-");
    commit(root, { "README.md": "# r\n", "pkg/a.ts": bump(), "pkg/b.ts": bump(), "other/x.ts": bump() });
    for (let i = 0; i < 3; i++) commit(root, { "pkg/a.ts": bump(), "pkg/b.ts": bump() });
    commit(root, { "other/x.ts": bump(), "README.md": bump() });
    return root;
  }

  it("keys churn relative to --repo and counts only history that touched it", () => {
    const root = monorepo();
    const sub = gitChurn(join(root, "pkg"));
    expect(sub.ok).toBe(true);
    expect(sorted(sub.churn)).toEqual({ "a.ts": 4, "b.ts": 4 });
    expect(sub.commits).toBe(4);
    // The same numbers as the root view, projected onto the prefix.
    const top = gitChurn(root);
    expect(top.churn.get("pkg/a.ts")).toBe(4);
    expect(top.churn.get("other/x.ts")).toBe(2);
    expect(top.commits).toBe(5);
  });

  it("reports diffs, hunks and changed files relative to --repo, dropping changes outside it", () => {
    const root = monorepo();
    writeFileSync(join(root, "pkg/a.ts"), "// 1\n// changed\n");
    writeFileSync(join(root, "README.md"), "# changed\n");
    writeFileSync(join(root, "pkg/new.ts"), "x\n");
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    const pkg = join(root, "pkg");
    expect(diffFiles(pkg, { mergeBase: head }).map((f) => f.path)).toEqual(["a.ts"]);
    expect([...diffHunks(pkg, { mergeBase: head }).keys()]).toEqual(["a.ts"]);
    expect([...changedSince(pkg, "HEAD")].sort()).toEqual(["a.ts", "new.ts"]);
  });
});

describe.skipIf(process.platform === "win32")("git output is immune to the user's config", () => {
  const QUOTE = 'src/quote"name.py';
  const TAB = "src/tab\tname.py";
  const SPACE = "src/dir with space/modé ülé.py";

  function hostile(): string {
    const root = newRepo("ci-hist-cfg-");
    commit(root, { [QUOTE]: "a = 1\nb = 2\n", [TAB]: "a = 1\nb = 2\n", [SPACE]: "a = 1\nb = 2\n" });
    commit(root, { [QUOTE]: "a = 1\nb = 3\n", [TAB]: "a = 1\nb = 3\n", [SPACE]: "a = 1\nb = 3\n" });
    // Each of these once corrupted a path or a hunk header we parse.
    for (const [key, value] of [
      ["color.ui", "always"],
      ["color.diff", "always"],
      ["diff.mnemonicPrefix", "true"],
      ["diff.noprefix", "true"],
      ["diff.relative", "true"],
      ["diff.external", "echo"],
      ["diff.interHunkContext", "10"],
      ["log.follow", "true"],
      ["log.showRoot", "false"],
    ]) {
      git(root, ["config", key!, value!]);
    }
    for (const rel of [QUOTE, TAB, SPACE]) writeFileSync(join(root, rel), "a = 9\nb = 3\n");
    return root;
  }

  it("hunks keep C-quoted and spaced paths, whatever the diff config", () => {
    const root = hostile();
    const hunks = diffHunks(root, { mergeBase: git(root, ["rev-parse", "HEAD"]).trim() });
    expect([...hunks.keys()].sort()).toEqual([SPACE, QUOTE, TAB].sort());
    for (const rel of [QUOTE, TAB, SPACE]) expect(hunks.get(rel)).toEqual([{ start: 1, end: 1 }]);
  });

  it("churn keys are the raw paths, root commit included", () => {
    const root = hostile();
    const { churn, ok } = gitChurn(root);
    expect(ok).toBe(true);
    expect(sorted(churn)).toEqual({ [SPACE]: 2, [QUOTE]: 2, [TAB]: 2 });
  });
});

describe("shallow clones", () => {
  function origin(): string {
    const root = newRepo("ci-hist-origin-");
    commit(root, { "a.ts": bump(), "b.ts": bump(), "c.ts": bump() });
    for (let i = 0; i < 4; i++) commit(root, { "a.ts": bump() });
    return root;
  }
  const clone = (src: string, depth?: number): string => {
    const dest = join(mkdtempSync(join(tmpdir(), "ci-hist-clone-")), "c");
    const args = ["clone", "-q", ...(depth ? ["--depth", String(depth)] : []), `file://${src}`, dest];
    execFileSync("git", args, { stdio: "ignore" });
    return dest;
  };

  it("skips the graft boundary (diffed against an empty tree it would 'change' every file) and says shallow", () => {
    const src = origin();
    const two = gitChurn(clone(src, 2));
    expect(two).toMatchObject({ ok: true, shallow: true, commits: 1 });
    expect(sorted(two.churn)).toEqual({ "a.ts": 1 });
    // depth 1 (actions/checkout's default): no visible change at all, not churn 1 everywhere.
    const one = gitChurn(clone(src, 1));
    expect(one).toMatchObject({ ok: true, shallow: true, commits: 0 });
    expect(one.churn.size).toBe(0);
    // A complete clone is neither flagged nor truncated.
    const full = gitChurn(clone(src));
    expect(full.shallow).toBeUndefined();
    expect(sorted(full.churn)).toEqual({ "a.ts": 5, "b.ts": 1, "c.ts": 1 });
  });
});

describe("since windows", () => {
  function dated(): { root: string; mid: string } {
    const root = newRepo("ci-hist-since-");
    commit(root, { "old.ts": bump() }, "2020-01-01T00:00:00Z");
    commit(root, { "old.ts": bump() }, "2020-02-01T00:00:00Z");
    const mid = git(root, ["rev-parse", "HEAD"]).trim();
    commit(root, { "new.ts": bump() }, "2024-06-01T00:00:00Z");
    commit(root, { "new.ts": bump(), "old.ts": bump() }, "2024-07-01T00:00:00Z");
    return { root, mid };
  }

  it("accepts a ref or a date", () => {
    const { root, mid } = dated();
    expect(sorted(gitChurn(root, { since: mid }).churn)).toEqual({ "new.ts": 2, "old.ts": 1 });
    expect(sorted(gitChurn(root, { since: "HEAD~1" }).churn)).toEqual({ "new.ts": 1, "old.ts": 1 });
    expect(sorted(gitChurn(root, { since: "2023-01-01" }).churn)).toEqual({ "new.ts": 2, "old.ts": 1 });
    expect(sorted(gitChurn(root, { since: "100 years ago" }).churn)).toEqual({ "new.ts": 2, "old.ts": 3 });
  });

  it("refuses what is neither, instead of an empty window that reads as 'nothing changed'", () => {
    const { root } = dated();
    for (const since of ["nosuchref", "HEAD~99", "v1.9.0"]) {
      expect(() => gitChurn(root, { since })).toThrow(/neither a commit .* nor a date/);
    }
  });

  it("says why there is no history", () => {
    expect(gitChurn(mkdtempSync(join(tmpdir(), "ci-hist-nogit-")))).toMatchObject({ ok: false, error: expect.stringMatching(/not a git repository/) });
    expect(gitChurn(newRepo("ci-hist-empty-"))).toMatchObject({ ok: false, error: expect.stringMatching(/no commits yet/) });
  });
});

describe("history memo", () => {
  it("serves an unchanged HEAD from memory and re-reads after a commit", () => {
    const root = newRepo("ci-hist-memo-");
    commit(root, { "a.ts": bump() });
    const first = gitChurn(root);
    expect(gitChurn(root)).toEqual(first);
    commit(root, { "a.ts": bump() });
    expect(gitChurn(root).churn.get("a.ts")).toBe(2);
  });
});
