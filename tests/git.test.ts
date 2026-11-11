import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSince, diffFiles, diffHunks, gitChurn, repoFilterOverrides, resolveBaseRef, untrackedFiles } from "../src/git.js";
import { walk } from "../src/walk.js";

// git hardening: the locale its messages are read in, and refs that git would
// otherwise take for options.

function repoWithCommit(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "a");
  writeFileSync(join(dir, "a.txt"), "b\n");
  return dir;
}

const LOCALE_KEYS = ["LC_ALL", "LANG", "LANGUAGE"] as const;
const savedLocale = Object.fromEntries(LOCALE_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of LOCALE_KEYS) {
    if (savedLocale[k] === undefined) delete process.env[k];
    else process.env[k] = savedLocale[k];
  }
});

describe("git runs in the C locale", () => {
  it("reports a missing repository in English whatever the user's locale", () => {
    process.env.LC_ALL = "fr_FR.UTF-8";
    process.env.LANG = "fr_FR.UTF-8";
    process.env.LANGUAGE = "fr";
    const res = gitChurn(mkdtempSync(join(tmpdir(), "ci-git-none-")));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^not a git repository/);
  });
});

describe("a ref that looks like an option never reaches git as one", () => {
  it("changedSince answers nothing and writes nothing", () => {
    const dir = repoWithCommit();
    const target = join(mkdtempSync(join(tmpdir(), "ci-git-out-")), "x");
    expect(changedSince(dir, `--output=${target}`).size).toBe(0);
    expect(existsSync(target)).toBe(false);
    expect([...changedSince(dir, "HEAD")]).toEqual(["a.txt"]);
  });

  it("diffFiles and diffHunks, which are public, refuse one as a merge-base", () => {
    const dir = repoWithCommit();
    const target = join(mkdtempSync(join(tmpdir(), "ci-git-out-")), "x");
    expect(diffFiles(dir, { mergeBase: `--output=${target}` })).toEqual([]);
    expect(diffHunks(dir, { mergeBase: `--output=${target}` }).size).toBe(0);
    expect(existsSync(target)).toBe(false);
    // Nothing to diff against is no diff, not a crash.
    expect(diffFiles(dir, {})).toEqual([]);
    expect(diffHunks(dir, {}).size).toBe(0);
    // A real base still answers.
    expect(diffFiles(dir, { mergeBase: "HEAD" })).toEqual([{ path: "a.txt", status: "modified", linesAdded: 1, linesDeleted: 1 }]);
    expect([...diffHunks(dir, { mergeBase: "HEAD" }).keys()]).toEqual(["a.txt"]);
  });

  it("a delta base starting with '-' is not found", () => {
    const dir = repoWithCommit();
    const target = join(mkdtempSync(join(tmpdir(), "ci-git-out-")), "x");
    expect(resolveBaseRef(dir, `--output=${target}`)).toEqual({ error: `base ref "--output=${target}" not found (tried git rev-parse --verify)` });
    expect(existsSync(target)).toBe(false);
  });

  it("a since window starting with '-' is neither a ref nor a date", () => {
    const dir = repoWithCommit();
    expect(() => gitChurn(dir, { since: "--all" })).toThrow(/neither a commit/);
  });
});

// A directory that arrives with its own .git/config — an unpacked archive, a
// shared mount, a nested clone — must not get to run a command because it was
// indexed. `core.fsmonitor` names one, and git runs it on ls-files and diff.
describe("a repository's own git config cannot run a command", () => {
  it("core.fsmonitor is not honoured by any call the engine makes", () => {
    const dir = repoWithCommit();
    const marker = join(mkdtempSync(join(tmpdir(), "ci-git-mark-")), "ran");
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    // A tracked file under `build/` makes the walk ask git which build dirs are tracked.
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, "build", "gen.ts"), "export const generated = 1;\n");
    git("add", "build/gen.ts");
    git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "build");
    git("config", "core.fsmonitor", `touch ${marker}; true`);

    // The setting does run a command when git is left to honour it.
    git("ls-files");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(walk(dir).files.map((f) => f.rel)).toContain("build/gen.ts");
    expect([...changedSince(dir, "HEAD")]).toEqual(["a.txt"]);
    expect(untrackedFiles(dir)).toEqual([]);
    expect(diffFiles(dir, { mergeBase: "HEAD" })).toHaveLength(1);
    expect(diffHunks(dir, { mergeBase: "HEAD" }).size).toBe(1);
    expect(resolveBaseRef(dir)).toHaveProperty("mergeBase");
    expect(gitChurn(dir).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("a clean or process filter the repository declares is not run by a worktree diff", () => {
    const dir = repoWithCommit();
    const marker = join(mkdtempSync(join(tmpdir(), "ci-git-mark-")), "ran");
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=x\n");
    git("config", "filter.x.clean", `sh -c 'touch ${marker}; cat'`);
    git("config", "filter.x.process", `sh -c 'touch ${marker}; exit 1'`);
    // The control: left to itself, git runs it for a stat-dirty file.
    git("diff", "--name-only");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(diffFiles(dir, { mergeBase: "HEAD" }).map((f) => f.path)).toEqual(["a.txt"]);
    expect([...diffHunks(dir, { mergeBase: "HEAD" }).keys()]).toEqual(["a.txt"]);
    expect([...changedSince(dir, "HEAD")].sort()).toEqual([".gitattributes", "a.txt"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("is not fooled by a filter command that mentions another driver's variable", () => {
    const dir = repoWithCommit();
    const marker = join(mkdtempSync(join(tmpdir(), "ci-git-mark-")), "ran");
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=x\n");
    // Parsed off `key value` lines, this named a driver "x.clean y" that does not exist.
    git("config", "filter.x.clean", `sh -c 'touch ${marker}; cat' y.clean z a.required b`);
    expect(diffFiles(dir, { mergeBase: "HEAD" }).map((f) => f.path)).toEqual(["a.txt"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not look into a dirty submodule, whose own filters it does not know", () => {
    const dir = repoWithCommit();
    const marker = join(mkdtempSync(join(tmpdir(), "ci-git-mark-")), "ran");
    const sub = join(dir, "sub");
    const at = (where: string, ...args: string[]) =>
      execFileSync("git", ["-C", where, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { stdio: "pipe" });
    mkdirSync(sub);
    at(sub, "init", "-q");
    writeFileSync(join(sub, ".gitattributes"), "*.txt filter=y\n");
    writeFileSync(join(sub, "s.txt"), "s\n");
    at(sub, "add", "-A");
    at(sub, "commit", "-q", "-m", "s");
    at(dir, "add", "sub");
    at(dir, "commit", "-q", "-m", "gitlink");
    at(sub, "config", "filter.y.clean", `sh -c 'touch ${marker}; cat'`);
    // Same size, new mtime: git must read it through the filter to compare.
    writeFileSync(join(sub, "s.txt"), "t\n");
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(sub, "s.txt"), later, later);
    // The control: a plain worktree diff runs the submodule's filter.
    at(dir, "diff", "--name-only");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    expect(diffFiles(dir, { mergeBase: "HEAD" }).map((f) => f.path)).toEqual(["a.txt"]);
    expect([...diffHunks(dir, { mergeBase: "HEAD" }).keys()]).toEqual(["a.txt"]);
    expect([...changedSince(dir, "HEAD")]).toEqual(["a.txt"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps git-lfs's standard driver, even declared in the repository, and no lookalike", () => {
    const dir = repoWithCommit();
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    git("config", "filter.lfs.clean", "git-lfs clean -- %f");
    git("config", "filter.lfs.smudge", "git-lfs smudge -- %f");
    git("config", "filter.lfs.process", "git-lfs filter-process");
    git("config", "filter.lfs.required", "true");
    git("config", "filter.mine.clean", "tr a-z A-Z");
    const overrides = repoFilterOverrides(dir);
    expect(overrides).toContain("filter.mine.clean=");
    expect(overrides.some((o) => o.startsWith("filter.lfs."))).toBe(false);
    // A driver named lfs that runs something else is the repository's command.
    git("config", "filter.lfs.process", "sh -c 'touch /tmp/x'");
    expect(repoFilterOverrides(dir)).toContain("filter.lfs.process=");
  });
});
