import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSince, gitChurn, resolveBaseRef } from "../src/git.js";

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
