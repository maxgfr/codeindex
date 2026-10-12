import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractImports } from "../src/extract/imports.js";
import { extractMarkdown } from "../src/extract/markdown.js";
import { collectCallsRegex } from "../src/extract/code.js";
import { loadEmbedModel } from "../src/embed/model.js";
import { wordpiece } from "../src/embed/encode.js";
import { scanRepo } from "../src/scan.js";
import { findDeadCode } from "../src/deadcode.js";
import { createFramer } from "../src/lsp/protocol.js";
import { deltaOfDiff, type DeltaDiff } from "../src/delta.js";
import { isIgnored, parseGitignore } from "../src/ignore.js";
import { diffHunks } from "../src/git.js";
import type { Edge, FileNode, Graph, ModuleNode } from "../src/types.js";

// A synthetic adversarial corpus: inputs a real repository can contain and that
// used to cost seconds to minutes (the `perf` cases, each held to a budget a
// linear algorithm meets with a wide margin), or to come out wrong (the rest).
// Generated into temp dirs, so it runs in CI with no network.

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const MODEL_DIR = fileURLToPath(new URL("./fixtures/embed-model", import.meta.url));

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

function tempRepo(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-adv-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

describe("perf: linear on adversarial input", () => {
  // `^\s*` under /gm crosses newlines, so every line start of a blank run
  // rescanned the rest of the run up to the first line that does not match:
  // 22 s for 100k blank lines of Rust.
  it.each([
    [".rs", "use crate::a::b;"],
    [".java", "import a.b.C;"],
    [".cs", "using A.B;"],
    [".rb", "require 'a/b'"],
    [".c", '#include "a.h"'],
  ])("perf: 100k blank lines before an import in %s", (ext, importLine) => {
    const { value, ms } = timed(() => extractImports(ext, "\n".repeat(100_000) + "x\n" + importLine + "\n"));
    expect(value.length).toBe(1);
    expect(ms).toBeLessThan(1500);
  });

  it("perf: 100k whitespace-only lines before a markdown link reference", () => {
    const { value, ms } = timed(() => extractMarkdown(" \n".repeat(100_000) + "x\n[a]: ./x.md\n\nsee [a]\n"));
    expect(value.refs.map((r) => r.spec)).toContain("./x.md");
    expect(ms).toBeLessThan(1500);
  });

  // The definition-introducer test rescanned the whole line prefix per match.
  it("perf: one line of 120k calls in the regex tier", () => {
    const line = "x = [" + "foo(1), ".repeat(120_000) + "]\n";
    const { value, ms } = timed(() => collectCallsRegex(line));
    expect(value.map((c) => c.name)).toEqual(["foo"]);
    expect(ms).toBeLessThan(1500);
  });

  // Greedy longest-match wordpiece tried every end for every start: cubic on a
  // word the vocabulary keeps matching piece by piece.
  it("perf: an 8,000-character word through the embedding tokenizer", () => {
    const model = loadEmbedModel(MODEL_DIR)!;
    const { value, ms } = timed(() => wordpiece("auth" + "token".repeat(1_600), model));
    expect(value).toEqual([model.unkId]);
    expect(ms).toBeLessThan(500);
  });

  // A name no call binds is looked for in its own file's text; every
  // occurrence copied the whole list of lines seen so far.
  it("perf: a helper passed around 40k times in its own file", () => {
    const root = tempRepo({
      "src/gen.ts": "export function helper(): number { return 1; }\n" + "use(helper);\n".repeat(40_000),
      "package.json": JSON.stringify({ name: "gen", private: true }),
    });
    const scan = scanRepo(root);
    const { value, ms } = timed(() => findDeadCode(scan));
    expect(Array.isArray(value)).toBe(true);
    expect(ms).toBeLessThan(1500);
  });

  // Every chunk reallocated and copied the whole buffer.
  it("perf: a 24 MB LSP response read in 64 KB chunks", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(24 * 1024 * 1024) });
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    const framer = createFramer();
    const { value, ms } = timed(() => {
      const out = [];
      for (let i = 0; i < frame.length; i += 64 * 1024) out.push(...framer.push(frame.subarray(i, i + 64 * 1024)));
      return out;
    });
    expect(value).toHaveLength(1);
    expect(ms).toBeLessThan(1500);
  });

  // Each changed file rebuilt the dependents map over every edge, twice.
  it("perf: delta over 2,000 changed leaves of a 100k-edge graph", () => {
    const core = 2_000;
    const files: FileNode[] = [];
    const node = (rel: string, module: string): FileNode =>
      ({ id: rel, kind: "file", rel, fileKind: "code", lang: "typescript", module, symbols: 0, lines: 10, degIn: 0, degOut: 0 }) as FileNode;
    for (let i = 0; i < core; i++) files.push(node(`core/f${i}.ts`, `core${i % 40}`));
    for (let i = 0; i < 2_000; i++) files.push(node(`leaf/l${i}.ts`, `leaf${i % 40}`));
    const fileEdges: Edge[] = [];
    for (let i = 0; i < 100_000; i++) {
      fileEdges.push({ from: `core/f${i % core}.ts`, to: `core/f${(i * 7919 + 1) % core}.ts`, kind: "import", weight: 1 } as Edge);
    }
    const slugs = [...new Set(files.map((f) => f.module))];
    const modules = slugs.map(
      (slug) => ({ id: slug, kind: "module", slug, path: slug, title: slug, summary: "", tier: "core", members: files.filter((f) => f.module === slug).map((f) => f.rel), symbols: 0, degIn: 0, degOut: 0 }) as unknown as ModuleNode,
    );
    const graph = { schemaVersion: 1, version: "t", fileCount: files.length, languages: {}, files, modules, fileEdges, moduleEdges: [] } as Graph;
    const diff: DeltaDiff = {
      base: { ref: "HEAD", mergeBase: "0".repeat(40), staged: false },
      files: files.filter((f) => f.rel.startsWith("leaf/")).map((f) => ({ path: f.rel, status: "modified" })),
      hunks: new Map(),
      notes: [],
    };
    const { value, ms } = timed(() => deltaOfDiff(diff, graph, undefined, { depth: 2 }));
    expect(value.changes).toHaveLength(2_000);
    expect(ms).toBeLessThan(1500);
  });
});

describe("adversarial inputs come out right", () => {
  it("a deeply nested JS file extracts the same with and without workers", { timeout: 120_000 }, () => {
    const deep = "export function shallow() { return 1; }\nexport const deep = " + "[".repeat(2_000) + "]".repeat(2_000) + ";\n";
    const filler: Record<string, string> = {};
    for (let i = 0; i < 8; i++) filler[`src/f${i}.js`] = `export function f${i}() { return ${i}; }\n`;
    const root = tempRepo({ "src/deep.js": deep, ...filler });
    const outDir = mkdtempSync(join(tmpdir(), "ci-adv-out-"));
    const outs = ["0", "2"].map((workers) => {
      const out = join(outDir, workers);
      const r = cli(["index", "--repo", root, "--out", out, "--workers", workers, "--no-index-cache"]);
      expect(r.status, r.stderr).toBe(0);
      return readFileSync(join(out, "symbols.json"), "utf8");
    });
    expect(outs[1]).toBe(outs[0]);
  });

  it("a file named __proto__ is cached like any other", () => {
    const root = tempRepo({ ["__proto__"]: "plain text\n", "a.ts": "export const a = 1;\n" });
    const out = join(root, ".codeindex");
    expect(cli(["index", "--repo", root, "--out", out]).status).toBe(0);
    const cache = JSON.parse(readFileSync(join(out, "cache.json"), "utf8")) as { files: Record<string, unknown> };
    expect(Object.keys(cache.files).sort()).toEqual(["__proto__", "a.ts"]);
    const again = cli(["index", "--repo", root, "--out", out]);
    expect(again.stderr).toMatch(/unchanged — artifacts reused/);
  });

  it("paths with spaces, unicode and a newline are indexed verbatim", () => {
    const names = ["a b.ts", "é/ü.ts", "new\nline.ts"];
    const root = tempRepo(Object.fromEntries(names.map((n, i) => [n, `export const v${i} = "needle";\n`])));
    const r = cli(["graph", "--repo", root]);
    expect(r.status, r.stderr).toBe(0);
    const graph = JSON.parse(r.stdout) as Graph;
    expect(graph.files.map((f) => f.rel).sort()).toEqual([...names].sort());
    const hits = JSON.parse(cli(["grep", "needle", "--repo", root]).stdout) as { file: string }[];
    expect(hits.map((h) => h.file).sort()).toEqual([...names].sort());
  });

  it("CRLF and a BOM leave declarations and their lines unchanged", () => {
    const lf = "// doc\nexport function alpha(): number {\n  return 1;\n}\n\nexport class Beta {\n  gamma(): void {}\n}\n";
    const root = tempRepo({ "lf.ts": lf, "crlf.ts": "﻿" + lf.replace(/\n/g, "\r\n") });
    const outline = (file: string) =>
      (JSON.parse(cli(["outline", file, "--repo", root, "--concise"]).stdout) as { name: string; line: number }[]).map((s) => [s.name, s.line]);
    expect(outline("crlf.ts")).toEqual(outline("lf.ts"));
    expect(outline("lf.ts").map(([n]) => n)).toEqual(["alpha", "Beta", "gamma"]);
  });

  it("a .gitignore negated class and a POSIX class match like git", () => {
    const rules = parseGitignore("x[^a]\n[[:digit:]]z\n", "");
    expect(isIgnored(rules, "xb", false)).toBe(true);
    expect(isIgnored(rules, "xa", false)).toBe(false);
    expect(isIgnored(rules, "x^", false)).toBe(false);
    expect(isIgnored(rules, "1z", false)).toBe(true);
    expect(isIgnored(rules, "az", false)).toBe(false);
  });

  it("an added line reading `++ b/x` stays in its own file's hunks", () => {
    const root = tempRepo({ "notes.md": Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n" });
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "root");
    git("add", "notes.md");
    git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "notes");
    const lines = readFileSync(join(root, "notes.md"), "utf8").split("\n");
    lines.splice(0, 0, "++ b/other.txt");
    lines[22] = "changed";
    writeFileSync(join(root, "notes.md"), lines.join("\n"));
    const head = String(git("rev-parse", "HEAD")).trim();
    const hunks = diffHunks(root, { mergeBase: head });
    expect([...hunks.keys()]).toEqual(["notes.md"]);
    expect(hunks.get("notes.md")!.map((h) => [h.start, h.end])).toEqual([
      [1, 1],
      [23, 23],
    ]);
  });
});
