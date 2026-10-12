import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, type ScanOptions } from "../src/scan.js";
import { callerIndexForNames, lookupCallerEntry, rawCallerSitesFor } from "../src/callers.js";

// What an evaluation on large real repositories (vite, TypeScript's Go port,
// django, terraform, ripgrep) found an agent would be misled by: answers that
// silently left out what the index could not see, and three binding gaps.

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-eval-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
const cli = (args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const callersOf = (root: string, ref: string, opts: ScanOptions = {}) => {
  const scan = scanRepo(root, opts);
  return lookupCallerEntry(callerIndexForNames(scan, [ref.replace(/@.*/, "")]), ref);
};
const lines = (entry: ReturnType<typeof callersOf>) => entry?.callers.map((c) => `${c.file}:${c.line}`) ?? [];

describe("the per-file call-site cap", () => {
  const many = repo({
    "lib.ts": "export function foo(): void {}\n",
    "many.ts": 'import { foo } from "./lib";\n' + "foo();\n".repeat(600),
  });

  it("keeps every site of a test file that calls one function hundreds of times", () => {
    expect(callersOf(many, "foo")?.callers).toHaveLength(600);
  });

  it("an answer cut by the cap names the files it may be missing sites from", () => {
    const r = cli(["callers", "foo", "--repo", many, "--max-calls", "10"]);
    expect(r.status, r.err).toBe(0);
    const answer = JSON.parse(r.out);
    expect(answer.coverage.callCapped).toEqual(["many.ts"]);
    expect(answer.coverage.hint).toMatch(/--max-calls/);
    // Uncapped, the answer carries no coverage note at all.
    expect(JSON.parse(cli(["callers", "foo", "--repo", many]).out).coverage).toBeUndefined();
  });
});

describe("a file over --max-bytes", () => {
  const big = repo({
    "go.mod": "module example.com/m\n\ngo 1.22\n",
    "checker/checker.go": "package checker\n\n// NewChecker builds a checker.\nfunc NewChecker() int { return 1 }\n" + "// padding\n".repeat(200),
    "checker/use.go": "package checker\n\nfunc use() int { return NewChecker() }\n",
  });
  const small = ["--repo", big, "--max-bytes", "1000"];

  it("outline says it was left out for size, and how to index it", () => {
    const r = cli(["outline", "checker/checker.go", ...small]);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/checker\/checker\.go is \d+ bytes, over --max-bytes/);
    expect(r.err).toMatch(/--max-bytes \d+/);
  });

  it("refs names the oversized file that mentions the symbol", () => {
    const r = cli(["refs", "NewChecker", ...small]);
    expect(r.status, r.err).toBe(0);
    const answer = JSON.parse(r.out);
    expect(answer.defs).toEqual([]);
    expect(answer.coverage.notIndexed).toEqual([{ file: "checker/checker.go", size: expect.any(Number) }]);
  });

  it("callers says where the undeclared symbol may be", () => {
    const r = cli(["callers", "NewChecker", ...small]);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/checker\/checker\.go/);
  });

  it("find says it too, on stderr, keeping stdout a bare array", () => {
    const r = cli(["find", "NewChecker", ...small]);
    expect(r.status, r.err).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
    expect(r.err).toMatch(/checker\/checker\.go/);
  });

  it("an answer the size limit cannot have touched carries no note", () => {
    expect(JSON.parse(cli(["refs", "use", ...small]).out).coverage).toBeUndefined();
  });
});

describe("Rust paths", () => {
  const crate = repo({
    "Cargo.toml": '[package]\nname = "x"\nversion = "0.1.0"\n',
    "src/main.rs": "mod a;\nmod search;\n\nfn search(x: u8) -> u8 { x }\n\nfn run() -> u8 { search(1) }\n\nfn helper() -> u8 { 1 }\n",
    "src/a.rs": "mod b;\n\npub fn top() -> u8 {\n    crate::helper()\n}\n",
    "src/a/b.rs": "pub fn deep() -> u8 {\n    crate::helper() + super::top()\n}\n",
    "src/search.rs": "pub fn s() {}\n",
  });

  it("crate:: reaches a private item of the crate root", () => {
    expect(lines(callersOf(crate, "helper"))).toEqual(["src/a.rs:4", "src/a/b.rs:2"]);
  });

  it("super:: reaches the parent module", () => {
    expect(lines(callersOf(crate, "top"))).toEqual(["src/a/b.rs:2"]);
  });

  it("a call never binds to a `mod` declaration of the same name", () => {
    const entry = callersOf(crate, "search@src/main.rs");
    expect(entry?.def.kind).toBe("function");
    expect(lines(entry)).toEqual(["src/main.rs:6"]);
  });
});

describe("the same function name called twice on one line", () => {
  const go = repo({
    "go.mod": "module example.com/m\n\ngo 1.22\n",
    "compiler/compiler.go": "package compiler\n\nfunc NewProgram() int { return 1 }\n",
    "incremental/incremental.go": "package incremental\n\nfunc NewProgram(x int) int { return x }\n",
    "execute/watcher.go": [
      "package execute",
      "",
      "import (",
      '\t"example.com/m/compiler"',
      '\t"example.com/m/incremental"',
      ")",
      "",
      "func Run() int { return incremental.NewProgram(compiler.NewProgram()) }",
      "",
    ].join("\n"),
  });

  it("keeps both calls when their receivers differ", () => {
    const sites = rawCallerSitesFor(scanRepo(go), "NewProgram").map((s) => `${s.file}:${s.line}:${s.receiver}`);
    expect(sites).toEqual(["execute/watcher.go:8:compiler", "execute/watcher.go:8:incremental"]);
    expect(lines(callersOf(go, "NewProgram@compiler/compiler.go"))).toEqual(["execute/watcher.go:8"]);
    expect(lines(callersOf(go, "NewProgram@incremental/incremental.go"))).toEqual(["execute/watcher.go:8"]);
  });

  it("lists a line once when both calls reach the same declaration", () => {
    const ts = repo({
      "lib.ts": "export function foo(x: number): number { return x; }\n",
      "use.ts": 'import { foo } from "./lib";\nexport const a = { foo };\nexport const y = foo(a.foo(1));\n',
    });
    expect(lines(callersOf(ts, "foo"))).toEqual(["use.ts:3"]);
  });
});

describe("subtokens' ASCII fast path", () => {
  // The Unicode spelling every input took before: an ASCII string must read
  // exactly as it did.
  const reference = (raw: string): string[] => {
    const folded = raw.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2");
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (t: string): void => {
      if (t.length < 2 || seen.has(t)) return;
      seen.add(t);
      out.push(t);
    };
    if (!/\s/.test(raw.trim())) push(raw.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ""));
    for (const part of folded.split(/[^\p{L}\p{N}]+/u)) push(part.toLowerCase());
    return out;
  };

  it("reads ASCII as the Unicode classes did", async () => {
    const { subtokens } = await import("../src/util.js");
    const samples = [
      "HTTPServerError", "parseJSON2XML", "snake_case_name", "__proto__", "sha1sum", "bm25Score", "a.b.c(d)",
      "  leading and trailing  ", "URLs and IDs", "x", "", "foo-bar_baz", "ABC", "aB", "Ab1Cd", "#!/usr/bin/env node",
      "getHTTP2Stream", "k8sCluster", "IOError: can't open", "$scope.$apply()", "tab\tseparated\nlines",
    ];
    for (const s of samples) expect(subtokens(s), s).toEqual(reference(s));
  });
});
