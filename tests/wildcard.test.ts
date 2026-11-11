// src/wildcard.ts: a glob-derived pattern must not be able to make matching
// backtrack. The patterns come from repository content (.gitignore, workspace
// manifests) and from MCP/CLI arguments, and a dozen stars used to cost tens of
// seconds for ONE path.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileDirExcludes, compileDirGlobs, compileGlobs } from "../src/glob.js";
import { isIgnored, parseGitignore } from "../src/ignore.js";
import { wildcardLinear, wildcardMatcher, wildcardRegExp, type WildToken } from "../src/wildcard.js";
import { detectWorkspaces } from "../src/workspaces.js";

// Generous: the backtracking forms below took from seconds to (extrapolated)
// years, the linear form well under a millisecond.
const BUDGET_MS = 1000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

// A small deterministic generator: the suite must not depend on Math.random.
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("wildcardLinear agrees with the RegExp form", () => {
  const KINDS: WildToken[] = [
    { kind: "lit", ch: "a" },
    { kind: "lit", ch: "b" },
    { kind: "lit", ch: "/" },
    { kind: "lit", ch: "." },
    { kind: "one" },
    { kind: "star" },
    { kind: "any" },
    { kind: "prefix" },
    { kind: "segments" },
    { kind: "class", source: "(?!/)[ab]" },
    { kind: "class", source: "[^/a]" },
    { kind: "class", source: "(?!)" },
  ];
  const ALPHABET = ["a", "b", "/", ".", "c", "\n"];

  it("on 4000 generated pattern/subject pairs, spanning and dir-prefix", () => {
    const next = lcg(20261110);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    let matched = 0;
    for (let n = 0; n < 4000; n++) {
      // At most 5 tokens, so the RegExp side of the comparison stays cheap.
      const tokens = Array.from({ length: 1 + Math.floor(next() * 5) }, () => pick(KINDS));
      const subject = Array.from({ length: Math.floor(next() * 9) }, () => pick(ALPHABET)).join("");
      for (const dirPrefix of [false, true]) {
        const expected = wildcardRegExp(tokens, { dirPrefix }).test(subject);
        const got = wildcardLinear(tokens, { dirPrefix })(subject);
        if (got !== expected) {
          throw new Error(`${JSON.stringify(tokens)} on ${JSON.stringify(subject)} (dirPrefix ${dirPrefix}): linear ${got}, regex ${expected}`);
        }
        if (expected) matched++;
      }
    }
    // The generator must exercise both verdicts, or the comparison proves nothing.
    expect(matched).toBeGreaterThan(400);
  });

  it("an empty pattern matches only the empty subject", () => {
    expect(wildcardLinear([])("")).toBe(true);
    expect(wildcardLinear([])("a")).toBe(false);
    expect(wildcardLinear([], { dirPrefix: true })("/a")).toBe(true);
  });

  it("wildcardMatcher switches form past two wildcards without changing the verdict", () => {
    const star: WildToken = { kind: "star" };
    const lit = (ch: string): WildToken => ({ kind: "lit", ch });
    const three = [star, lit("."), star, lit("."), star];
    expect(wildcardMatcher(three)("a.b.c")).toBe(true);
    expect(wildcardMatcher(three)("a.b")).toBe(false);
    expect(wildcardMatcher(three)("a/b.c.d")).toBe(false);
  });
});

describe("pathological patterns answer in linear time", () => {
  it("--include/--exclude globs: `a*a*…b` no longer backtracks", () => {
    const glob = "a*".repeat(30) + "b";
    const match = compileGlobs([glob])!;
    const miss = timed(() => match("a".repeat(200)));
    expect(miss.value).toBe(false);
    expect(miss.ms).toBeLessThan(BUDGET_MS);
    expect(match("a".repeat(200) + "b")).toBe(true);
  });

  it("globs: repeated `**/` no longer backtracks", () => {
    const match = compileGlobs(["**/".repeat(25) + "x.ts"])!;
    const deep = "d/".repeat(60);
    const miss = timed(() => match(deep + "y.ts"));
    expect(miss.value).toBe(false);
    expect(miss.ms).toBeLessThan(BUDGET_MS);
    expect(match(deep + "x.ts")).toBe(true);
    expect(match("x.ts")).toBe(true);
  });

  it("directory pruning and whole-directory excludes go through the same matcher", () => {
    const seg = "a*".repeat(30) + "b";
    const dirs = compileDirGlobs([`${seg}/file.ts`])!;
    const pruned = timed(() => dirs("a".repeat(200)));
    expect(pruned.value).toBe(false);
    expect(pruned.ms).toBeLessThan(BUDGET_MS);
    expect(dirs("a".repeat(40) + "b")).toBe(true);

    const excluded = compileDirExcludes([`${seg}/**`])!;
    const kept = timed(() => excluded("a".repeat(200)));
    expect(kept.value).toBe(false);
    expect(kept.ms).toBeLessThan(BUDGET_MS);
    expect(excluded("a".repeat(40) + "b")).toBe(true);
  });

  it(".gitignore: a floating `a*a*…b` line cannot hang the walk", () => {
    const rules = parseGitignore("a*".repeat(30) + "b\n", "");
    const miss = timed(() => isIgnored(rules, "src/" + "a".repeat(200), false));
    expect(miss.value).toBe(false);
    expect(miss.ms).toBeLessThan(BUDGET_MS);
    expect(isIgnored(rules, "src/" + "a".repeat(200) + "b", false)).toBe(true);
  });

  it(".gitignore: an anchored `**/**/…/x` line cannot hang the walk", () => {
    const rules = parseGitignore("**/".repeat(25) + "x\n", "pkg");
    const deep = "pkg/" + "d/".repeat(60);
    const miss = timed(() => isIgnored(rules, deep + "y", false));
    expect(miss.value).toBe(false);
    expect(miss.ms).toBeLessThan(BUDGET_MS);
    expect(isIgnored(rules, deep + "x", false)).toBe(true);
    expect(isIgnored(rules, "pkg/x", false)).toBe(true);
    // Anchored to the .gitignore's own directory.
    expect(isIgnored(rules, "other/x", false)).toBe(false);
  });

  it(".gitignore: bracket expressions keep their meaning past the switch", () => {
    const rules = parseGitignore("*[0-9]*[!a-c]*.log\n", "");
    expect(isIgnored(rules, "run1x.log", false)).toBe(true);
    expect(isIgnored(rules, "run1a.log", false)).toBe(false); // nothing outside a-c before `.log`
    expect(isIgnored(rules, "run1ax.log", false)).toBe(true);
    expect(isIgnored(rules, "runx.log", false)).toBe(false); // no digit
    expect(isIgnored(rules, "dir/run1x.log", false)).toBe(true);
  });

  it("workspace manifests: a negation with many stars cannot hang detection", () => {
    const root = mkdtempSync(join(tmpdir(), "codeindex-wildcard-"));
    const long = "a".repeat(120);
    for (const dir of ["packages/kept", `packages/${long}`]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: dir.split("/")[1] }));
    }
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*", "!packages/" + "a*".repeat(30) + "b"] }),
    );
    const detected = timed(() => detectWorkspaces(root));
    expect(detected.ms).toBeLessThan(BUDGET_MS);
    expect(detected.value.packages.map((p) => p.dir)).toEqual(["packages/" + long, "packages/kept"].sort());
  });

  it("workspace globs match a name holding a character outside the BMP", () => {
    // Past two wildcards the linear matcher runs, which compares UTF-16 units.
    const root = mkdtempSync(join(tmpdir(), "codeindex-wildcard-astral-"));
    mkdirSync(join(root, "packages", "a1b2c3😀x"), { recursive: true });
    writeFileSync(join(root, "packages", "a1b2c3😀x", "package.json"), JSON.stringify({ name: "astral" }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/a*b*c*😀x"] }));
    expect(detectWorkspaces(root).packages.map((p) => p.name)).toEqual(["astral"]);
  });
});
