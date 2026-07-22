// Regression tests for the adversarial-review findings (F1-F4, F6-F11).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { walk } from "../src/walk.js";
import { parseGitignore, isIgnored } from "../src/ignore.js";
import { detectWorkspaces } from "../src/workspaces.js";
import { grepRepo } from "../src/grep.js";
import { compileGlobFilter } from "../src/glob.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

describe("F1: maven parent poms", () => {
  it("reads the module's own artifactId, not the parent's", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-mvnfix-"));
    writeFileSync(
      join(root, "pom.xml"),
      "<project><artifactId>parent</artifactId><modules><module>core</module><module>web</module></modules></project>",
    );
    for (const [mod, deps] of [
      ["core", ""],
      ["web", "<dependencies><dependency><groupId>g</groupId><artifactId>core</artifactId></dependency></dependencies>"],
    ] as const) {
      mkdirSync(join(root, mod));
      writeFileSync(
        join(root, mod, "pom.xml"),
        `<project><parent><groupId>g</groupId><artifactId>parent</artifactId><version>1</version></parent><artifactId>${mod}</artifactId>${deps}</project>`,
      );
    }
    const info = detectWorkspaces(root);
    expect(info.packages.map((p) => p.name)).toEqual(["core", "web"]);
    expect(info.packages.find((p) => p.name === "web")!.dependsOn).toEqual(["core"]);
    expect(info.topoOrder).toEqual(["core", "web"]);
  });
});

describe("F2: grep parity on a hostile fixture", () => {
  it("both backends agree outside a git repo, on binaries, locks, gitignored files and globs", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-grepfix-"));
    writeFileSync(join(root, ".gitignore"), "gen.txt\n");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "deep.ts"), "NEEDLE here\n");
    writeFileSync(join(root, "top.ts"), "NEEDLE top\n");
    writeFileSync(join(root, "pic.svg"), "<svg>NEEDLE</svg>\n");
    writeFileSync(join(root, "custom.lock"), "NEEDLE lock\n");
    writeFileSync(join(root, "gen.txt"), "NEEDLE gen\n");

    const js = grepRepo(root, "NEEDLE", { noRipgrep: true });
    const auto = grepRepo(root, "NEEDLE");
    expect(js.map((h) => h.file)).toEqual(["src/deep.ts", "top.ts"]);
    expect(auto).toEqual(js);

    // Rooted glob dialect: `*.ts` means root-level only, on BOTH backends.
    const jsGlob = grepRepo(root, "NEEDLE", { globs: ["*.ts"], noRipgrep: true });
    const autoGlob = grepRepo(root, "NEEDLE", { globs: ["*.ts"] });
    expect(jsGlob.map((h) => h.file)).toEqual(["top.ts"]);
    expect(autoGlob).toEqual(jsGlob);

    // Invalid pattern throws identically instead of one backend returning [].
    expect(() => grepRepo(root, "unclosed(", { noRipgrep: true })).toThrow();
    expect(() => grepRepo(root, "unclosed(")).toThrow();
  });
});

describe("F3: in-repo directory symlinks", () => {
  it("indexes the canonical directory only — never the alias, regardless of name order", () => {
    for (const alias of ["aa-alias", "zz-alias"]) {
      const root = mkdtempSync(join(tmpdir(), "ci-dirlink-"));
      mkdirSync(join(root, "mid"));
      writeFileSync(join(root, "mid", "file.ts"), "export const a = 1;\n");
      symlinkSync(join(root, "mid"), join(root, alias));
      const rels = walk(root).files.map((f) => f.rel);
      expect(rels).toEqual(["mid/file.ts"]);
    }
  });
});

describe("F4: maxFiles cap in flat directories", () => {
  it("never overshoots and sets capped exactly when files were dropped", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-cap-"));
    for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.ts`), "export {};\n");
    const r = walk(root, { maxFiles: 2 });
    expect(r.files.length).toBe(2);
    expect(r.capped).toBe(true);
    // Deterministic which files survive: sorted walk order.
    expect(r.files.map((f) => f.rel)).toEqual(["f0.ts", "f1.ts"]);
    const full = walk(root);
    expect(full.files.length).toBe(5);
    expect(full.capped).toBe(false);
  });
});

describe("F6/F7/F11: CLI flag validation", () => {
  const run = (args: string[]) => {
    try {
      return { out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" }), code: 0 };
    } catch (e) {
      const err = e as { status: number; stderr: string };
      return { out: err.stderr, code: err.status };
    }
  };

  it("rejects non-numeric --max-bytes instead of disabling the cap", () => {
    const r = run(["scan", "--repo", ".", "--max-bytes", "zz"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--max-bytes expects a positive number");
  });

  it("errors on a nonexistent --repo instead of reporting an empty repo", () => {
    const r = run(["scan", "--repo", "/nonexistent-path-codeindex-test"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("does not exist");
  });

  it("grep honors --include", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-grepcli-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.ts"), "TOKEN\n");
    writeFileSync(join(root, "sub", "b.ts"), "TOKEN\n");
    const all = JSON.parse(run(["grep", "TOKEN", "--repo", root]).out) as { file: string }[];
    expect(all.map((h) => h.file)).toEqual(["a.ts", "sub/b.ts"]);
    const scoped = JSON.parse(run(["grep", "TOKEN", "--repo", root, "--include", "sub/**"]).out) as { file: string }[];
    expect(scoped.map((h) => h.file)).toEqual(["sub/b.ts"]);
  });
});

describe("F9: mid-segment ** behaves like a single-segment *", () => {
  it("a**b matches axb but not a/deep/zb (git semantics)", () => {
    const r = parseGitignore("a**b\n", "");
    expect(isIgnored(r, "axb", false)).toBe(true);
    expect(isIgnored(r, "ab", false)).toBe(true);
    expect(isIgnored(r, "a/deep/zb", false)).toBe(false);
  });
});

describe("issue #3: grepRepo negation globs", () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "ci-grepneg-"));
    mkdirSync(join(root, "sub", "gen"), { recursive: true });
    writeFileSync(join(root, "a.ts"), "NEEDLE root\n");
    writeFileSync(join(root, "sub", "b.ts"), "NEEDLE sub\n");
    writeFileSync(join(root, "sub", "gen", "c.ts"), "NEEDLE gen\n");
    return root;
  }

  function files(root: string, globs: string[], noRipgrep: boolean): string[] {
    return grepRepo(root, "NEEDLE", { globs, noRipgrep }).map((h) => h.file);
  }

  it("a lone negation glob means `everything but`, on both backends", () => {
    const root = makeRepo();
    expect(files(root, ["!sub/**"], true)).toEqual(["a.ts"]);
    expect(files(root, ["!sub/**"], false)).toEqual(files(root, ["!sub/**"], true));
  });

  it("mixes positive and negated globs with exclusion winning, on both backends", () => {
    const root = makeRepo();
    expect(files(root, ["sub/**", "!sub/gen/**"], true)).toEqual(["sub/b.ts"]);
    expect(files(root, ["sub/**", "!sub/gen/**"], false)).toEqual(["sub/b.ts"]);
  });

  it("exclusion beats inclusion regardless of the caller's glob order", () => {
    const root = makeRepo();
    expect(files(root, ["!sub/gen/**", "sub/**"], true)).toEqual(["sub/b.ts"]);
    expect(files(root, ["!sub/gen/**", "sub/**"], false)).toEqual(["sub/b.ts"]);
  });

  it("accepts the `/`-anchored spelling after the negation, on both backends", () => {
    const root = makeRepo();
    expect(files(root, ["!/sub/**"], true)).toEqual(["a.ts"]);
    expect(files(root, ["!/sub/**"], false)).toEqual(["a.ts"]);
  });

  it("compileGlobFilter exposes the same semantics for library callers", () => {
    const f = compileGlobFilter(["src/**", "!src/gen/**"])!;
    expect(f("src/a.ts")).toBe(true);
    expect(f("src/gen/a.ts")).toBe(false);
    expect(f("lib/a.ts")).toBe(false);
    expect(compileGlobFilter([])).toBeNull();
    const only = compileGlobFilter(["!dist/**"])!;
    expect(only("src/a.ts")).toBe(true);
    expect(only("dist/a.js")).toBe(false);
  });

  it("the CLI --exclude flag rides the negation path end to end", () => {
    const root = makeRepo();
    const out = execFileSync(process.execPath, [CLI, "grep", "NEEDLE", "--repo", root, "--exclude", "sub/**"], {
      encoding: "utf8",
    });
    expect((JSON.parse(out) as { file: string }[]).map((h) => h.file)).toEqual(["a.ts"]);
  });
});
