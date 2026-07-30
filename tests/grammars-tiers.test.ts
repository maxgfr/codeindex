import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORE_GRAMMARS,
  EXTENDED_GRAMMARS,
  EXT_GRAMMAR,
  allGrammarKeys,
  grammarKeyForExt,
  grammarReady,
  resolveGrammarsTier,
} from "../src/ast/loader.js";
import { extractAst } from "../src/ast/extract.js";
import { extractCode } from "../src/extract/code.js";
import { SPECS } from "../src/ast/specs.js";
import { extractTags, tagsQueryStatus } from "../src/ast/tags.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORE_DIR = join(ROOT, "scripts", "grammars");
const EXT_DIR = join(ROOT, "scripts", "grammars-extended");

// The two grammar tiers, and the property that matters about the split: the
// COMMITTED set is what every consumer gets for free, the EXTENDED set arrives
// only through `grammars pull`, and a repo whose language is in neither (or whose
// pull never happened) must degrade to the regex tier in silence rather than
// break.
describe("grammar tiers", () => {
  it("every committed wasm belongs to the core tier, and vice versa", () => {
    const onDisk = readdirSync(CORE_DIR)
      .filter((f) => f.endsWith(".wasm") && f !== "web-tree-sitter.wasm")
      .map((f) => f.replace(/\.wasm$/, ""))
      .sort();
    expect(onDisk).toEqual([...CORE_GRAMMARS].sort());
  });

  it("the extended tier is NOT committed to git", () => {
    // `.gitignore` covers scripts/grammars-extended/, so a fresh clone has none
    // of it. This asserts the DECLARED split, not the working tree (the test
    // command regenerates the dir before running).
    for (const key of EXTENDED_GRAMMARS) expect(CORE_GRAMMARS.has(key)).toBe(false);
  });

  it("the two tiers are disjoint and together cover every mapped extension", () => {
    const all = new Set([...CORE_GRAMMARS, ...EXTENDED_GRAMMARS]);
    expect(all.size).toBe(CORE_GRAMMARS.size + EXTENDED_GRAMMARS.size);
    for (const key of Object.values(EXT_GRAMMAR)) expect(all.has(key)).toBe(true);
    expect(allGrammarKeys().sort()).toEqual([...all].sort());
  });

  it("every grammar key has a LangSpec — a mapped extension with no spec would parse into nothing", () => {
    for (const key of allGrammarKeys()) expect(SPECS[key], `no LangSpec for grammar "${key}"`).toBeDefined();
  });

  it("resolves both tier directories in a dev checkout", () => {
    const tier = resolveGrammarsTier();
    expect(tier.dirs.length).toBeGreaterThanOrEqual(1);
    expect(tier.dirs[0]).toBe(tier.dir);
    if (existsSync(EXT_DIR)) expect(tier.dirs).toContain(EXT_DIR);
  });

  it("maps the extended languages' extensions", () => {
    expect(grammarKeyForExt(".kt")).toBe("kotlin");
    expect(grammarKeyForExt(".ex")).toBe("elixir");
    expect(grammarKeyForExt(".zig")).toBe("zig");
    expect(grammarKeyForExt(".sol")).toBe("solidity");
    expect(grammarKeyForExt(".tf")).toBe("terraform");
    expect(grammarKeyForExt(".hcl")).toBe("hcl");
  });

  it("falls back to the regex tier for a language with no grammar, without throwing", () => {
    // Swift publishes no prebuilt wasm; Dart's does not load under
    // web-tree-sitter 0.26. Both must still yield symbols.
    expect(extractAst("a.swift", ".swift", "func f() {}")).toBeUndefined();
    expect(extractCode("a.swift", ".swift", "func greet() {}\n").symbols.map((s) => s.name)).toContain("greet");
    expect(extractAst("a.dart", ".dart", "void f() {}")).toBeUndefined();
    expect(extractCode("a.dart", ".dart", "class Widget {}\nvoid build() {}\n").symbols.map((s) => s.name)).toEqual(
      expect.arrayContaining(["Widget", "build"]),
    );
  });
});

describe("extended-tier extraction", () => {
  // Skipped rather than failed when the tier is absent: a contributor who runs
  // vitest directly (bypassing the `pnpm test` script that regenerates the dir)
  // should see a skip, not a red suite for something they did not break.
  const ready = (key: string): boolean => grammarReady(key);

  it.skipIf(!ready("kotlin"))("Kotlin: interface members, enum entries, heritage split", () => {
    const src = [
      "interface Runnable { fun start() }",
      "class Worker : BaseWorker(), Runnable {",
      "    private val queue: String = \"\"",
      "    override fun start() {}",
      "}",
      "enum class Outcome { OK, FAIL }",
      "",
    ].join("\n");
    const info = extractCode("W.kt", ".kt", src);
    const byId = new Map(info.symbols.map((s) => [(s.parent ? s.parent + "/" : "") + s.name, s]));
    expect(byId.get("Runnable")!.kind).toBe("interface");
    expect(byId.get("Runnable/start")!.exported).toBe(true);
    expect(byId.get("Worker/queue")!.exported).toBe(false);
    expect(byId.get("Outcome/OK")!.kind).toBe("enum-member");
    // A constructor-invoking parent is the superclass; a bare one is an interface.
    expect(info.relations).toEqual([
      { kind: "extends", from: "Worker", to: "BaseWorker", line: 2 },
      { kind: "implements", from: "Worker", to: "Runnable", line: 2 },
    ]);
  });

  it.skipIf(!ready("elixir"))("Elixir: declarations are macro calls, and are not also call sites", () => {
    const src = ["defmodule App.Worker do", "  @doc \"Start it.\"", "  def start(q) do", "    reset(q)", "  end", "", "  defp reset(_q), do: :ok", "end", ""].join("\n");
    const info = extractCode("w.ex", ".ex", src);
    const byId = new Map(info.symbols.map((s) => [(s.parent ? s.parent + "/" : "") + s.name, s]));
    expect(byId.get("App.Worker")!.kind).toBe("module");
    expect(byId.get("App.Worker/start")!.exported).toBe(true);
    expect(byId.get("App.Worker/start")!.doc).toBe("Start it.");
    expect(byId.get("App.Worker/reset")!.exported).toBe(false);
    // `def start(q)` must NOT register a call to `start`; only the real call remains.
    expect((info.calls ?? []).map((c) => c.name)).toEqual(["reset"]);
  });

  it.skipIf(!ready("zig"))("Zig: a type is a const bound to a container, and @import is not a declaration", () => {
    const src = [
      'const std = @import("std");',
      "pub const Point = struct {",
      "    x: u32,",
      "    pub fn norm(self: *Point) u32 { return self.x; }",
      "};",
      "",
    ].join("\n");
    const info = extractCode("p.zig", ".zig", src);
    const names = info.symbols.map((s) => (s.parent ? s.parent + "/" : "") + s.name);
    expect(names).not.toContain("std");
    expect(names).toEqual(expect.arrayContaining(["Point", "Point/x", "Point/norm"]));
    expect(info.symbols.find((s) => s.name === "Point")!.kind).toBe("struct");
    // The signature must stop at the container literal, not swallow the fields.
    expect(info.symbols.find((s) => s.name === "Point")!.signature).not.toContain("x: u32");
  });

  it.skipIf(!ready("solidity"))("Solidity: contract members, visibility and inheritance", () => {
    const src = [
      "interface IRun { function go() external; }",
      "contract C is Base, IRun {",
      "    uint256 public total;",
      "    address private owner;",
      "    function go() external {}",
      "}",
      "enum E { A, B }",
      "",
    ].join("\n");
    const info = extractCode("C.sol", ".sol", src);
    const byId = new Map(info.symbols.map((s) => [(s.parent ? s.parent + "/" : "") + s.name, s]));
    expect(byId.get("C")!.kind).toBe("contract");
    expect(byId.get("C/total")!.exported).toBe(true);
    expect(byId.get("C/owner")!.exported).toBe(false);
    expect(byId.get("E/A")!.kind).toBe("enum-member");
    // `is Base, IRun` does not distinguish the two; graph resolution corrects it.
    expect(info.relations).toEqual([
      { kind: "extends", from: "C", to: "Base", line: 2 },
      { kind: "extends", from: "C", to: "IRun", line: 2 },
    ]);
  });

  it.skipIf(!ready("terraform"))("Terraform: a block's labels are its address, and nested blocks are not symbols", () => {
    const src = [
      "# The fleet.",
      'resource "aws_instance" "web" {',
      '  ami = "x"',
      "  lifecycle { create_before_destroy = true }",
      "}",
      'variable "region" { type = string }',
      "",
    ].join("\n");
    const info = extractCode("main.tf", ".tf", src);
    const names = info.symbols.map((s) => s.name);
    expect(names).toEqual(["aws_instance.web", "region"]);
    expect(info.symbols[0]!.kind).toBe("resource");
    expect(info.symbols[0]!.doc).toBe("The fleet.");
    // `lifecycle` is configuration, not a declaration anyone looks up.
    expect(names).not.toContain("lifecycle");
  });
});

// The official `tags.scm` view — an INDEPENDENT statement of what a file
// declares, used by the quality audit to catch what a hand-written spec table
// forgot. Public API, so it has to behave for a consumer too.
describe("extractTags (official tags.scm queries)", () => {
  it("reads definitions through the grammar's own query", () => {
    // Deliberately probed with constructs TypeScript's OFFICIAL query covers —
    // an interface and an ambient function. Its tags.scm does not match a plain
    // `class Widget {}` at all, which is precisely why these queries are used as
    // a cross-check and not as the extractor.
    const src = ["interface Shape {", "  area(): number;", "}", "declare function build(): void;", ""].join("\n");
    const tags = extractTags(".ts", src);
    expect(tags.map((t) => t.name)).toEqual(expect.arrayContaining(["Shape", "area", "build"]));
    // Kinds come from the `@definition.<kind>` capture name.
    expect(tags.find((t) => t.name === "Shape")!.kind).toBe("interface");
    expect(tags.every((t) => t.line >= 1)).toBe(true);
  });

  it("is deterministic and deduped", () => {
    const src = "export interface Shape { area(): number }\n";
    expect(extractTags(".ts", src)).toEqual(extractTags(".ts", src));
  });

  it("returns [] for a language with no grammar, and for a grammar with no query", () => {
    // Swift has no wasm at all; bash has a wasm but publishes no tags.scm.
    expect(extractTags(".swift", "func f() {}")).toEqual([]);
    expect(extractTags(".sh", "f() { :; }")).toEqual([]);
  });

  it("never throws on unparseable input", () => {
    expect(() => extractTags(".ts", "class {{{ <<< not valid")).not.toThrow();
  });

  it("every vendored query compiles against its grammar", () => {
    // A query the installed grammar rejects degrades to [] silently, which would
    // make the audit quietly stop auditing while still looking green. Checking
    // COMPILATION rather than captures is what distinguishes "out of step with
    // the wasm" from "this query legitimately matches nothing here".
    const unusable: string[] = [];
    for (const key of allGrammarKeys()) {
      if (!grammarReady(key)) continue;
      const status = tagsQueryStatus(key);
      if (status.present && !status.compiled) unusable.push(key);
    }
    expect(unusable, "vendored tags.scm out of step with its grammar").toEqual([]);
  });

  it("reports query status honestly for a grammar that publishes none", () => {
    // bash ships a wasm but no tags.scm; asking must say "absent", not "broken".
    expect(tagsQueryStatus("bash")).toEqual({ present: false, compiled: false });
    if (grammarReady("typescript")) expect(tagsQueryStatus("typescript")).toEqual({ present: true, compiled: true });
  });
});
