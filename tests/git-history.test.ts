// Git-history analytics (churn, hotspots, coupling) and the diff plumbing
// behind `delta`, against real temporary repositories: --repo below the git
// toplevel, hostile user config, shallow clones, since windows, the history
// memo, and coupling's index filter and ranking.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changedSince, diffFiles, diffHunks, gitChurn } from "../src/git.js";
import { changeCoupling, rankHotspots } from "../src/coupling.js";
import { onboardBrief } from "../src/onboard.js";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { scanRepo } from "../src/scan.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

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

  it("keys coupling relative to --repo, and sizes the mass-refactor cut by the WHOLE commit", () => {
    const root = monorepo();
    expect(changeCoupling(join(root, "pkg"), { minTogether: 3 }).couplings).toMatchObject([{ a: "a.ts", b: "b.ts", together: 4 }]);
    // Four files in total, two of them in pkg/ — like the initial commit. Sized
    // by what lands in pkg/ (2) both would pass a cap of 3; sized whole, only
    // the three pair commits do.
    commit(root, { "pkg/a.ts": bump(), "pkg/b.ts": bump(), "other/y.ts": bump(), "other/z.ts": bump() });
    expect(changeCoupling(join(root, "pkg"), { minTogether: 3, maxCommitFiles: 3 }).couplings).toMatchObject([
      { a: "a.ts", b: "b.ts", together: 3 },
    ]);
    expect(changeCoupling(join(root, "pkg"), { minTogether: 3, maxCommitFiles: 4 }).couplings).toMatchObject([
      { a: "a.ts", b: "b.ts", together: 5 },
    ]);
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

  it("churn and coupling keys are the raw paths, root commit included", () => {
    const root = hostile();
    const { churn, ok } = gitChurn(root);
    expect(ok).toBe(true);
    expect(sorted(churn)).toEqual({ [SPACE]: 2, [QUOTE]: 2, [TAB]: 2 });
    const pairs = changeCoupling(root, { minTogether: 2 }).couplings.map((c) => [c.a, c.b]);
    expect(pairs).toContainEqual([QUOTE, TAB]);
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
    expect(changeCoupling(clone(src, 1), { minTogether: 1 })).toMatchObject({ ok: true, shallow: true, couplings: [] });
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
    expect(changeCoupling(root, { since: "2024-06-15", minTogether: 1 }).couplings).toMatchObject([{ a: "new.ts", b: "old.ts" }]);
  });

  it("refuses what is neither, instead of an empty window that reads as 'nothing changed'", () => {
    const { root } = dated();
    for (const since of ["nosuchref", "HEAD~99", "v1.9.0"]) {
      expect(() => gitChurn(root, { since })).toThrow(/neither a commit .* nor a date/);
      expect(() => changeCoupling(root, { since })).toThrow(/neither a commit .* nor a date/);
    }
  });

  it("says why there is no history", () => {
    expect(gitChurn(mkdtempSync(join(tmpdir(), "ci-hist-nogit-")))).toMatchObject({ ok: false, error: expect.stringMatching(/not a git repository/) });
    expect(gitChurn(newRepo("ci-hist-empty-"))).toMatchObject({ ok: false, error: expect.stringMatching(/no commits yet/) });
    expect(changeCoupling(newRepo("ci-hist-empty-"))).toMatchObject({ ok: false, error: expect.stringMatching(/no commits yet/) });
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

describe("change coupling over the index", () => {
  // a↔b: 12 of their 13 commits each, and an import between them. c↔d: 3 of
  // 3, no edge. gone.ts co-changes with c.ts and d.ts, then is deleted.
  function coupled(): string {
    const root = newRepo("ci-hist-coupling-");
    commit(root, { "a.ts": 'import { b } from "./b";\nexport const a = b;\n', "b.ts": "export const b = 1;\n" });
    for (let i = 0; i < 11; i++) commit(root, { "a.ts": `import { b } from "./b";\nexport const a = b + ${i};\n`, "b.ts": `export const b = ${i};\n` });
    commit(root, { "a.ts": 'import { b } from "./b";\nexport const a = b * 2;\n' });
    commit(root, { "b.ts": "export const b = 2;\n" });
    for (let i = 0; i < 3; i++) commit(root, { "c.ts": `export const c = ${i};\n`, "d.ts": `export const d = ${i};\n`, "gone.ts": bump() });
    git(root, ["rm", "-q", "gone.ts"]);
    git(root, ["commit", "-qm", "rm"]);
    return root;
  }

  it("ranks by confidence, so 12/13 outranks a thin 3/3", () => {
    const { couplings } = changeCoupling(coupled());
    expect(couplings.slice(0, 2).map((c) => [c.a, c.b, c.together, c.strength, c.confidence])).toEqual([
      ["a.ts", "b.ts", 12, 0.923, 0.667],
      ["c.ts", "d.ts", 3, 1, 0.438],
    ]);
  });

  it("with the graph: keeps indexed files only and marks which pairs an edge explains", () => {
    const root = coupled();
    // Without the index the deleted file still couples.
    expect(changeCoupling(root).couplings.some((c) => c.a === "gone.ts" || c.b === "gone.ts")).toBe(true);
    const { graph } = buildIndexArtifacts(root);
    const { couplings } = changeCoupling(root, { graph });
    expect(couplings.map((c) => [c.a, c.b, c.linked])).toEqual([
      ["a.ts", "b.ts", true],
      ["c.ts", "d.ts", false],
    ]);
    expect(changeCoupling(root, { graph, hidden: true }).couplings.map((c) => [c.a, c.b])).toEqual([["c.ts", "d.ts"]]);
  });

  it("leaves out pairs the file names already declare (x.po/x.mo, x.ts/x.test.ts)", () => {
    const root = newRepo("ci-hist-stem-");
    for (let i = 0; i < 3; i++) {
      commit(root, { "l/x.po": bump(), "l/x.mo": bump(), "l/y.po": bump(), "src/.eslintrc.json": bump(), "src/.eslintrc.js": bump() });
    }
    const pairs = changeCoupling(root, { maxPairs: 100 }).couplings.map((c) => `${c.a} ${c.b}`);
    expect(pairs).not.toContain("l/x.mo l/x.po");
    expect(pairs).not.toContain("src/.eslintrc.js src/.eslintrc.json");
    expect(pairs).toContain("l/x.mo l/y.po");
    expect(pairs).toContain("l/x.po l/y.po");
  });

  it("drops scope-excluded files through the graph", () => {
    const root = coupled();
    const { graph } = buildIndexArtifacts(root, { exclude: ["d.ts"] });
    expect(changeCoupling(root, { graph }).couplings.map((c) => [c.a, c.b])).toEqual([["a.ts", "b.ts"]]);
  });
});

describe("hotspots", () => {
  it("ranks only files that changed, and labels tests", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-hist-hot-"));
    writeFileSync(join(root, "big.ts"), "export const x = 1;\n".repeat(200));
    writeFileSync(join(root, "hot.ts"), "export const y = 1;\n".repeat(10));
    writeFileSync(join(root, "hot.test.ts"), "export const z = 1;\n".repeat(10));
    const churn = new Map([
      ["hot.ts", 3],
      ["hot.test.ts", 2],
    ]);
    const spots = rankHotspots(scanRepo(root), churn);
    expect(spots.map((s) => [s.rel, s.commits, s.test])).toEqual([
      ["hot.ts", 3, undefined],
      ["hot.test.ts", 2, true],
    ]);
    expect(rankHotspots(scanRepo(root), churn, 1)).toHaveLength(1);
  });
});

describe("onboard's 'Where work concentrates'", () => {
  const brief = (root: string): string => {
    const { scan, graph } = buildIndexArtifacts(root);
    return onboardBrief(scan, graph, { remember: false }).brief;
  };

  it("ranks from ten commits up, never pads with unchanged files, and labels tests", () => {
    const root = newRepo("ci-hist-onboard-");
    commit(root, { "still.ts": "export const s = 1;\n".repeat(50) });
    for (let i = 0; i < 8; i++) commit(root, { "hot.ts": bump(), "hot.test.ts": bump() });
    expect(brief(root)).not.toContain("Where work concentrates"); // 9 commits
    commit(root, { "hot.ts": bump() });
    // Indexed, larger than anything else, never committed: it used to pad the
    // list, ranked by size with 0 commits.
    writeFileSync(join(root, "fresh.ts"), "export const f = 1;\n".repeat(300));
    const text = brief(root);
    expect(text).toContain("## Where work concentrates");
    expect(text).toMatch(/- `hot\.ts` — 9 commits, \d+ lines\n/);
    expect(text).toMatch(/- `hot\.test\.ts` — 8 commits, \d+ lines \(test\)\n/);
    expect(text).toMatch(/- `still\.ts` — 1 commits, \d+ lines\n/);
    expect(text).not.toMatch(/`fresh\.ts` — \d+ commits/);
  });
});

describe("CLI", () => {
  const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

  it("exits 2 on a --since that is neither a ref nor a date", () => {
    const root = newRepo("ci-hist-cli-");
    commit(root, { "a.ts": bump() });
    const res = cli(["churn", "--repo", root, "--since", "nosuchref"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/since "nosuchref" is neither/);
  });

  it("applies --scope/--include/--exclude to churn keys and --limit to hotspots", () => {
    const root = newRepo("ci-hist-cli-");
    commit(root, { "src/a.ts": bump(), "src/b.ts": bump(), "docs/x.ts": bump() });
    commit(root, { "src/a.ts": bump(), "docs/x.ts": bump() });
    const churn = JSON.parse(cli(["churn", "--repo", root, "--scope", "src", "--exclude", "src/b.ts"]).stdout);
    expect(churn).toEqual({ ok: true, churn: { "src/a.ts": 2 } });
    const hot = JSON.parse(cli(["hotspots", "--repo", root, "--limit", "1", "--no-index-cache"]).stdout);
    expect(hot.hotspots.map((h: { rel: string }) => h.rel)).toHaveLength(1);
  });
});
