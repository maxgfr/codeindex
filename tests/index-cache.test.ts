// `codeindex index` and the cache.json it persists: when a record or an
// artifact may be reused, and when it must not be. Every test drives the shipped
// CLI (scripts/cli.mjs) against a scratch copy of the mini-repo fixture, because
// the failures this file pins were all invisible to the library — each was a
// reuse decision the CLI got wrong while every output-equality test passed.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { headCommit } from "../src/git.js";
import { ENGINE_VERSION } from "../src/types.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const SCRIPTS = fileURLToPath(new URL("../scripts", import.meta.url));
const CLI = join(SCRIPTS, "cli.mjs");
// A dev shell's embedding model must never turn the embed leg of the index
// fastpath on for these runs.
const ENV = { ...process.env, CODEINDEX_EMBED_DIR: "" };

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function scratch(prefix = "ci-index-cache-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function freshRepo(): string {
  const repo = join(scratch(), "repo");
  cpSync(FIXTURE, repo, { recursive: true });
  return repo;
}

function cli(args: string[], env: NodeJS.ProcessEnv = ENV): { stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`cli ${args.join(" ")} exited ${res.status}: ${res.stderr}`);
  return { stdout: res.stdout, stderr: res.stderr };
}
// Runs `index` and reports whether it took the "unchanged" fastpath.
function index(repo: string, out: string, ...flags: string[]): boolean {
  return cli(["index", "--repo", repo, "--out", out, ...flags]).stderr.includes("(unchanged — artifacts reused)");
}
const read = (dir: string, name: string): string => readFileSync(join(dir, name), "utf8");
function sameArtifacts(a: string, b: string): void {
  expect(read(a, "graph.json")).toBe(read(b, "graph.json"));
  expect(read(a, "symbols.json")).toBe(read(b, "symbols.json"));
}

// (schemaVersion, extractorVersion) pin the extractor's code, not the setting
// it ran under. The tier (--no-ast, a grammar arriving later) and --max-calls
// both change code records without touching any freshness key, so switching
// either used to print "unchanged — artifacts reused" over the old records.
describe("the extraction profile gates record reuse", { timeout: 120_000 }, () => {
  it("--no-ast, then a default index: rebuilt at the AST tier, byte-identical to cold", () => {
    const repo = freshRepo();
    const out = join(scratch(), "out");
    const cold = join(scratch(), "cold");
    index(repo, cold);
    index(repo, out, "--no-ast");
    expect(read(out, "symbols.json")).not.toBe(read(cold, "symbols.json")); // the tiers really differ here
    expect(index(repo, out)).toBe(false);
    sameArtifacts(out, cold);
    expect(index(repo, out)).toBe(true); // and it settles
  });

  it("a default index, then --no-ast: rebuilt at the regex tier, byte-identical to cold", () => {
    const repo = freshRepo();
    const out = join(scratch(), "out");
    const cold = join(scratch(), "cold");
    index(repo, cold, "--no-ast");
    index(repo, out);
    expect(index(repo, out, "--no-ast")).toBe(false);
    sameArtifacts(out, cold);
    expect(index(repo, out, "--no-ast")).toBe(true);
  });

  it("--max-calls: a new cap rebuilds, the same cap reuses", () => {
    const repo = freshRepo();
    const out = join(scratch(), "out");
    const cold = join(scratch(), "cold");
    index(repo, cold, "--max-calls", "1");
    index(repo, out);
    expect(read(out, "graph.json")).not.toBe(read(cold, "graph.json"));
    expect(index(repo, out, "--max-calls", "1")).toBe(false);
    sameArtifacts(out, cold);
    expect(index(repo, out, "--max-calls", "1")).toBe(true);
  });

  it("records the profile in cache.json", () => {
    const repo = freshRepo();
    const out = join(scratch(), "out");
    const profile = (): unknown => (JSON.parse(read(out, "cache.json")) as { extraction?: unknown }).extraction;
    index(repo, out);
    expect(profile()).toEqual({ grammars: expect.arrayContaining(["typescript"]) });
    index(repo, out, "--max-calls", "7");
    expect(profile()).toEqual({ grammars: expect.arrayContaining(["typescript"]), maxCallsPerFile: 7 });
    index(repo, out, "--no-ast");
    expect(profile()).toEqual({ grammars: [] });
  });

  it("read commands honour --no-ast / --max-calls against an index built without them", () => {
    const repo = freshRepo();
    index(repo, join(repo, ".codeindex"));
    const q = (...args: string[]): string => cli([...args, "--repo", repo]).stdout;
    expect(q("symbols", "--no-ast")).not.toBe(q("symbols"));
    expect(q("symbols", "--no-ast")).toBe(q("symbols", "--no-ast", "--no-index-cache"));
    expect(q("graph", "--max-calls", "1")).not.toBe(q("graph"));
    expect(q("graph", "--max-calls", "1")).toBe(q("graph", "--max-calls", "1", "--no-index-cache"));
    expect(q("graph")).toBe(read(join(repo, ".codeindex"), "graph.json"));
  });
});

// The (size, mtime) fastpath is a heuristic; the documented escape hatches for
// an edit that keeps both are --full-hash and --no-index-cache. `index` had
// neither: --full-hash was an unknown flag, --no-index-cache was ignored.
describe("index escape hatches for a same-size edit under a restored mtime", { timeout: 60_000 }, () => {
  it("--full-hash re-hashes, --no-index-cache rebuilds from scratch", () => {
    const repo = freshRepo();
    const out = join(scratch(), "out");
    const file = join(repo, "src", "util.ts");
    // A whole-second mtime, so restoring it is exact (a Date drops sub-ms).
    const stamp = new Date(2020, 0, 1);
    utimesSync(file, stamp, stamp);
    index(repo, out);
    const original = readFileSync(file, "utf8");
    const name = /export function (\w+)/.exec(original)![1]!;
    const renamed = name.slice(0, -1) + (name.endsWith("Q") ? "R" : "Q"); // same length ⇒ same size
    const setContent = (text: string): void => {
      writeFileSync(file, text);
      utimesSync(file, stamp, stamp);
    };
    setContent(original.replace(`function ${name}`, `function ${renamed}`));
    expect(statSync(file).size).toBe(original.length);

    expect(index(repo, out)).toBe(true); // the heuristic, as documented
    expect(read(out, "symbols.json")).not.toContain(`"${renamed}"`);
    expect(index(repo, out, "--full-hash")).toBe(false);
    expect(read(out, "symbols.json")).toContain(`"${renamed}"`);

    setContent(original);
    expect(index(repo, out)).toBe(true);
    expect(read(out, "symbols.json")).toContain(`"${renamed}"`); // stale again, by the same heuristic
    expect(index(repo, out, "--no-index-cache")).toBe(false);
    expect(read(out, "symbols.json")).not.toContain(`"${renamed}"`);
  });
});

// Every file lives under an --out that IS the repo root (or an ancestor), and
// the self-index guard excluded them all: a 0-file graph, exit 0.
describe("index --out at or above the repo root", { timeout: 60_000 }, () => {
  it("--out at the root indexes the repo, skips only its own artifacts, and settles", () => {
    const repo = freshRepo();
    const elsewhere = join(scratch(), "out");
    index(repo, elsewhere);
    expect(index(repo, repo)).toBe(false);
    sameArtifacts(repo, elsewhere);
    expect(JSON.parse(read(repo, "graph.json")).fileCount).toBeGreaterThan(0);
    expect(index(repo, repo)).toBe(true);
    expect(cli(["graph", "--repo", repo, "--index", "."]).stdout).toBe(read(repo, "graph.json"));
  });

  it("--out above the root indexes the whole repo", () => {
    const repo = freshRepo();
    const elsewhere = join(scratch(), "out");
    index(join(repo, "src"), elsewhere);
    index(join(repo, "src"), repo);
    sameArtifacts(repo, elsewhere);
  });

  it("warns when nothing at all was indexed", () => {
    const repo = freshRepo();
    const { stderr } = cli(["index", "--repo", repo, "--out", join(scratch(), "out"), "--include", "no-such-dir/**"]);
    expect(stderr).toContain("warning: no file");
  });
});

describe("index artifacts are replaced atomically", { timeout: 60_000 }, () => {
  // A hard link shares the inode. An in-place rewrite (the old truncate + write)
  // changes what the link reads; a rename-based replacement leaves the link on
  // the old, complete file — which is exactly what a concurrent reader holding
  // the old file sees instead of a torn one.
  it("writes a new file and renames it over the old one — never truncates in place", () => {
    const repo = freshRepo();
    const out = join(scratch(), "out");
    index(repo, out);
    const names = ["graph.json", "symbols.json", "cache.json"];
    const before = names.map((n) => read(out, n));
    for (const n of names) linkSync(join(out, n), join(out, `${n}.link`));
    appendFileSync(join(repo, "src", "util.ts"), "\nexport function atomicProbe(): number {\n  return 1;\n}\n");
    expect(index(repo, out)).toBe(false);
    names.forEach((n, i) => {
      expect(read(out, `${n}.link`)).toBe(before[i]);
      expect(read(out, n)).not.toBe(before[i]);
    });
    expect(read(out, "symbols.json")).toContain("atomicProbe");
    expect(readdirSync(out).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});

// `rev-parse --short` sizes the abbreviation from the object count: the same
// commit printed 7 characters in one clone and 8 in another, and graph.json's
// bytes (plus the fastpath) changed with it.
describe("graph.json commit stamp", { timeout: 60_000 }, () => {
  it("is a fixed-length prefix of HEAD, whatever git's own abbreviation", () => {
    const repo = freshRepo();
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "one");
    git("config", "core.abbrev", "12");
    const full = git("rev-parse", "HEAD");
    expect(git("rev-parse", "--short", "HEAD")).toHaveLength(12);
    expect(headCommit(repo)).toBe(full.slice(0, 7));
    const out = join(scratch(), "out");
    index(repo, out);
    expect(JSON.parse(read(out, "graph.json")).commit).toBe(full.slice(0, 7));
    git("config", "core.abbrev", "9");
    expect(index(repo, out)).toBe(true);
  });
});

// graph.json embeds the HEAD commit and symbols.json nothing git-related, so a
// HEAD move over an identical tree (committing already-indexed edits, an
// amend) changes one field. It used to rerun the whole pipeline.
describe("a new commit over an unchanged tree", { timeout: 60_000 }, () => {
  const gitIn = (repo: string) => (...args: string[]): string =>
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  const restamps = (repo: string, out: string): boolean =>
    cli(["index", "--repo", repo, "--out", out]).stderr.includes("graph.json restamped, symbols.json reused");

  it("restamps graph.json, keeps symbols.json, and matches a cold build", () => {
    const repo = freshRepo();
    const git = gitIn(repo);
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "one");
    const out = join(scratch(), "out");
    index(repo, out);
    const symbolsInode = statSync(join(out, "symbols.json")).ino;
    git("commit", "-q", "--allow-empty", "-m", "two");
    expect(restamps(repo, out)).toBe(true);
    expect(statSync(join(out, "symbols.json")).ino).toBe(symbolsInode); // never rewritten
    expect(JSON.parse(read(out, "graph.json")).commit).toBe(headCommit(repo));
    const cold = join(scratch(), "cold");
    index(repo, cold);
    sameArtifacts(out, cold);
    expect(index(repo, out)).toBe(true); // and cache.json now describes the new stamp
  });

  // Indexed outside git, graph.json has no `commit` key at all; the stamp must
  // land where a fresh build puts it, not at the end.
  it("gives a graph indexed outside git its stamp in build order", () => {
    const repo = freshRepo();
    const out = join(scratch(), "out");
    index(repo, out);
    expect(JSON.parse(read(out, "graph.json")).commit).toBeUndefined();
    const git = gitIn(repo);
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "one");
    expect(restamps(repo, out)).toBe(true);
    const cold = join(scratch(), "cold");
    index(repo, cold);
    sameArtifacts(out, cold);
    expect(Object.keys(JSON.parse(read(out, "graph.json"))).slice(0, 3)).toEqual(["schemaVersion", "version", "commit"]);
  });
});

// The npm layout: the bundle ships scripts/grammars (CORE) and nothing else;
// `grammars pull` puts CORE + EXTENDED into the shared cache. The adjacent dir
// used to be the only one searched, so pulled Kotlin never loaded and
// `grammars status` still said nothing was missing.
const EXTENDED = join(SCRIPTS, "grammars-extended");
describe.skipIf(!existsSync(join(EXTENDED, "kotlin.wasm")))("pulled EXTENDED grammars next to a bundled CORE set", { timeout: 60_000 }, () => {
  it("loads a pulled grammar and reports what is still missing", () => {
    const root = scratch("ci-npm-layout-");
    const pkg = join(root, "pkg", "scripts");
    mkdirSync(pkg, { recursive: true });
    for (const f of ["engine.mjs", "cli.mjs"]) copyFileSync(join(SCRIPTS, f), join(pkg, f));
    cpSync(join(SCRIPTS, "grammars"), join(pkg, "grammars"), { recursive: true });
    const cacheHome = join(root, "xdg");
    const cache = join(cacheHome, "codeindex", "grammars", ENGINE_VERSION);
    mkdirSync(cache, { recursive: true });
    copyFileSync(join(EXTENDED, "kotlin.wasm"), join(cache, "kotlin.wasm"));
    const repo = join(root, "kt");
    mkdirSync(repo);
    writeFileSync(
      join(repo, "Main.kt"),
      "package demo\n\nobject Registry {\n  val items = mutableListOf<String>()\n  fun add(x: String) { items.add(x) }\n}\n",
    );
    const env = { ...ENV, CODEINDEX_GRAMMAR_DIR: "", ULTRAINDEX_GRAMMAR_DIR: "", CODEINDEX_GRAMMARS_DIR: "", XDG_CACHE_HOME: cacheHome };
    const run = (args: string[]): string =>
      execFileSync(process.execPath, [join(pkg, "cli.mjs"), ...args], { encoding: "utf8", env });

    const status = JSON.parse(run(["grammars", "status"])) as {
      tier: string;
      dirs: string[];
      pullNeeded: boolean;
      extendedPullNeeded: boolean;
      extended: { missing: string[] };
    };
    expect(status.tier).toBe("adjacent");
    expect(status.dirs).toEqual([join(pkg, "grammars"), cache]);
    expect(status.pullNeeded).toBe(false);
    expect(status.extended.missing).not.toContain("kotlin");
    expect(status.extendedPullNeeded).toBe(true); // the other five are still missing

    // The AST tier nests `add` under its object, which the regex tier (it
    // reports no `parent`) does not, and agrees with the dev checkout, whose
    // sibling grammars-extended/ has Kotlin.
    type Defs = Record<string, { parent?: string }[]>;
    const parentOfAdd = (json: string): string | undefined => (JSON.parse(json) as { defs: Defs }).defs.add?.[0]?.parent;
    const symbols = run(["symbols", "--repo", repo, "--no-index-cache"]);
    expect(parentOfAdd(symbols)).toBe("Registry");
    expect(symbols).toBe(cli(["symbols", "--repo", repo, "--no-index-cache"]).stdout);
    rmSync(join(cache, "kotlin.wasm"));
    expect(parentOfAdd(run(["symbols", "--repo", repo, "--no-index-cache"]))).toBeUndefined();
  });
});
