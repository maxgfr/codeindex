import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_FLAGS, VALUE_FLAGS, parseFlags, parseMcpFlags } from "../src/engine-cli.js";

// The CLI's argument contract: a flag a command does not read, an unknown
// single-dash token or a stray positional is an error (exit 2) with a
// suggestion, never silently ignored or searched for.

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const cli = (args: string[], cwd?: string) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

describe("flags a command does not read", () => {
  it("rejects an unknown single-dash token instead of searching for it", () => {
    const n = cli(["grep", "-n", "--repo", REPO]);
    expect(n.status).toBe(2);
    expect(n.err).toMatch(/unknown flag: -n/);
    const i = cli(["grep", "-i", "foo", "--repo", REPO]);
    expect(i.status).toBe(2);
    expect(i.err).toMatch(/unknown flag: -i \(did you mean --ignore-case\?\)/);
    // A pattern that starts with "-" goes after --.
    expect(cli(["grep", "--", "-n", "--repo", REPO]).status).toBe(0);
  });

  it("rejects a flag the command does not read, naming the ones it does", () => {
    const r = cli(["grep", "import", "--limit", "1", "--repo", REPO]);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/--limit does not apply to grep/);
    expect(r.err).toMatch(/--max-hits/);
    expect(cli(["search", "foo", "--since", "x", "--repo", REPO]).status).toBe(2);
    expect(cli(["search", "foo", "--json", "--repo", REPO]).status).toBe(2);
  });

  it("rejects a positional the command does not take", () => {
    const scan = cli(["scan", "extra", "--repo", REPO]);
    expect(scan.status).toBe(2);
    expect(scan.err).toMatch(/scan takes no argument, got "extra"/);
    expect(cli(["graph", "x", "--repo", REPO]).status).toBe(2);
    expect(cli(["callpath", "a", "b", "c", "--repo", REPO]).status).toBe(2);
  });

  it("an unknown command is refused before any walk, with a suggestion", () => {
    const r = cli(["staus", "--repo", "/nonexistent-path-for-sure"]);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/^unknown command: staus \(did you mean status\?\)/);
  });

  it("<command> --help prints that command's help and the flags it reads", () => {
    const r = cli(["grep", "--help"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^codeindex grep\n/);
    expect(r.out).toMatch(/--max-hits <n>/);
    expect(r.out).not.toMatch(/--budget-tokens/);
    expect(cli(["scan", "-h"]).out).toMatch(/^codeindex scan\n/);
  });

  it("a leading --kinds takes its value (it is a value flag)", () => {
    const r = cli(["--kinds", "all", "deadcode", "--repo", REPO]);
    expect(r.status, r.err).toBe(0);
  });

  it("every flag that takes a value is one the hoisting knows takes one", () => {
    const all = new Set(["--repo", "--out", "--include", "--exclude", "--scope", "--no-gitignore", "--ignore-dir", "--max-files", "--max-bytes", "--max-calls", "--no-ast", "--workers", "--index", "--no-index-cache", "--full-hash", ...Object.values(COMMAND_FLAGS).flatMap((c) => c.flags)]);
    const takesValue = (flag: string): boolean => {
      try {
        parseFlags([flag]);
        return false;
      } catch (e) {
        return /missing value/.test(String(e));
      }
    };
    for (const flag of all) expect(VALUE_FLAGS.has(flag), flag).toBe(takesValue(flag));
  });

  it("number flags take whole numbers only", () => {
    for (const args of [["--depth", "0.5"], ["--max-files", "2.5"], ["--workers", ""], ["--max-bytes", ""]]) {
      expect(() => parseFlags(args), args.join(" ")).toThrow(/expects a/);
    }
  });
});

describe("output", () => {
  it("--out - writes to stdout, and no file named '-'", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ci-out-dash-"));
    const r = cli(["scan", "--repo", REPO, "--out", "-"], cwd);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out).fileCount).toBeGreaterThan(0);
    expect(readdirSync(cwd)).toEqual([]);
    expect(cli(["index", "--repo", REPO, "--out", "-"], cwd).status).toBe(2);
  });

  it("a failing gate still exits 1 when its reader closes the pipe", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ci-gate-pipe-"));
    cpSync(REPO, repo, { recursive: true });
    writeFileSync(join(repo, "rules.json"), JSON.stringify([{ name: "no-src-to-src", from: "src/**", to: "src/**" }]));
    const child = spawn(process.execPath, [CLI, "rules", "--repo", repo, "--config", join(repo, "rules.json")], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.destroy(); // the reader is gone before a byte is written
    const code = await new Promise<number | null>((settle) => child.on("close", settle));
    expect(code).toBe(1);
  });

  it("--out writes through a symlink instead of replacing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-out-link-"));
    writeFileSync(join(dir, "real.json"), "old\n");
    symlinkSync(join(dir, "real.json"), join(dir, "link.json"));
    expect(cli(["graph", "--repo", REPO, "--out", join(dir, "link.json")]).status).toBe(0);
    expect(lstatSync(join(dir, "link.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "real.json"), "utf8")).fileCount).toBeGreaterThan(0);
  });

  it("mcp --repo must be a directory", () => {
    expect(() => parseMcpFlags(["--repo", join(REPO, "README.md")])).toThrow(/not a directory/);
  });

  it("a reader closing the pipe early ends the command quietly with exit 0", async () => {
    // Output far larger than one pipe buffer, so the write outlives the reader.
    const big = mkdtempSync(join(tmpdir(), "ci-epipe-"));
    writeFileSync(join(big, "many.ts"), Array.from({ length: 4000 }, (_, i) => `export function generatedFunctionNumber${i}(): number { return ${i}; }`).join("\n") + "\n");
    const child = spawn(process.execPath, [CLI, "symbols", "--repo", big], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise<number | null>((settle) => child.on("close", settle));
    expect(err).not.toMatch(/EPIPE|Unhandled/);
    expect(code).toBe(0);
  });
});

describe("rewrite takes ONE command line", () => {
  it("refuses several arguments instead of joining them into another command", () => {
    const r = cli(["rewrite", "grep", "-r", "foo bar"]);
    expect(r.status).toBe(1);
    expect(r.out).toBe("");
  });

  it("does not fold codeindex's own leading flags into the command line", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ci-rewrite-"));
    const r = cli(["--max-hits", "40", "rewrite", "grep -r foo ."], cwd);
    expect(r.status).toBe(0);
    expect(r.out).toBe("codeindex grep foo --ignore-dir .codeindex\n");
  });

  it("refuses a search over a tree holding a git submodule", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ci-rewrite-sub-"));
    writeFileSync(join(cwd, ".gitmodules"), '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.com/lib\n');
    expect(existsSync(join(cwd, ".gitmodules"))).toBe(true);
    expect(cli(["rewrite", "grep -r foo ."], cwd).status).toBe(1);
    expect(cli(["rewrite", "grep -r foo src"], cwd).status).toBe(0); // the submodule is not in src
    expect(cli(["rewrite", "git grep foo"], cwd).status).toBe(0); // git grep skips submodules too
  });
});
