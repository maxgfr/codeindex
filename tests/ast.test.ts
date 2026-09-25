import { describe, it, expect, beforeAll } from "vitest";
import { ensureGrammars, allGrammarKeys, grammarReady } from "../src/ast/loader.js";
import { extractAst } from "../src/ast/extract.js";
import { collectCallsRegex } from "../src/extract/code.js";

// Load every committed grammar once before the suite. This exercises the exact
// path the CLI uses (wasmBinary init + Language.load from scripts/grammars/).
beforeAll(async () => {
  await ensureGrammars(allGrammarKeys());
});

const names = (rel: string, ext: string, src: string) =>
  (extractAst(rel, ext, src)?.symbols ?? []).map((s) => s.name);

describe("AST extraction (tree-sitter)", () => {
  it("loads every committed grammar", () => {
    for (const k of allGrammarKeys()) expect(grammarReady(k)).toBe(true);
  });

  it("extracts TypeScript declarations with exported/parent/endLine", () => {
    const src = [
      "export function foo(a: number): number { return a }",
      "function bar() {}",
      "export class Widget {",
      "  render() { return 1 }",
      "}",
      "export interface Shape { area(): number }",
      "export type Id = string",
      "export const K = 1",
    ].join("\n");
    const syms = extractAst("src/w.ts", ".ts", src)!.symbols;
    const foo = syms.find((s) => s.name === "foo")!;
    expect(foo.kind).toBe("function");
    expect(foo.exported).toBe(true);
    expect(foo.endLine).toBe(1);
    expect(syms.find((s) => s.name === "bar")!.exported).toBe(false);
    const render = syms.find((s) => s.name === "render")!;
    expect(render.kind).toBe("method");
    expect(render.parent).toBe("Widget");
    expect(syms.find((s) => s.name === "Shape")!.kind).toBe("interface");
    expect(syms.find((s) => s.name === "Id")!.kind).toBe("type");
  });

  it("captures TS import specifiers", () => {
    const refs = extractAst("a.ts", ".ts", "import { x } from './y';\nimport z from 'pkg';\n")!.refs;
    const specs = refs.map((r) => r.spec);
    expect(specs).toContain("./y");
    expect(specs).toContain("pkg");
  });

  it("extracts Python with public/private convention and nested methods", () => {
    const src = "class A:\n    def method(self):\n        return 1\n    def _hidden(self):\n        pass\n\ndef top():\n    return 2\n";
    const syms = extractAst("m.py", ".py", src)!.symbols;
    expect(syms.find((s) => s.name === "A")!.kind).toBe("class");
    const method = syms.find((s) => s.name === "method")!;
    expect(method.parent).toBe("A");
    expect(method.exported).toBe(true);
    expect(syms.find((s) => s.name === "_hidden")!.exported).toBe(false);
    expect(syms.find((s) => s.name === "top")!.exported).toBe(true);
  });

  it("extracts Go with exported-by-capitalization", () => {
    const src = "package p\n\nimport \"fmt\"\n\nfunc Exported() {}\nfunc unexported() {}\ntype Widget struct{}\n";
    const res = extractAst("g.go", ".go", src)!;
    const syms = res.symbols;
    expect(syms.find((s) => s.name === "Exported")!.exported).toBe(true);
    expect(syms.find((s) => s.name === "unexported")!.exported).toBe(false);
    expect(syms.find((s) => s.name === "Widget")!.kind).toBe("type");
    expect(res.refs.map((r) => r.spec)).toContain("fmt");
  });

  it("extracts Ruby methods and classes (all exported)", () => {
    const src = "class Foo\n  def bar\n  end\nend\n\nmodule M\nend\n";
    const nms = names("r.rb", ".rb", src);
    expect(nms).toEqual(expect.arrayContaining(["Foo", "bar", "M"]));
  });

  it("extracts Java with public visibility and package", () => {
    const src = "package com.acme.app;\n\npublic class Service {\n  public void run() {}\n  private int n;\n}\n";
    const res = extractAst("S.java", ".java", src)!;
    expect(res.pkg).toBe("com.acme.app");
    expect(res.symbols.find((s) => s.name === "Service")!.exported).toBe(true);
    expect(res.symbols.find((s) => s.name === "run")!.parent).toBe("Service");
  });

  it("extracts Rust pub visibility", () => {
    const src = "pub fn open() {}\nfn closed() {}\npub struct Handle;\n";
    const syms = extractAst("l.rs", ".rs", src)!.symbols;
    expect(syms.find((s) => s.name === "open")!.exported).toBe(true);
    expect(syms.find((s) => s.name === "closed")!.exported).toBe(false);
    expect(syms.find((s) => s.name === "Handle")!.kind).toBe("struct");
  });

  it("returns undefined for a language with no grammar at all (regex fallback)", () => {
    // Swift and Dart have a regex extractor but NO loadable wasm anywhere —
    // Swift publishes no prebuilt wasm, and Dart's does not load under
    // web-tree-sitter 0.26. Kotlin used to belong here and now ships in the
    // extended tier, which is exactly why this asserts against languages that
    // genuinely have none rather than against whichever one was missing that week.
    expect(extractAst("s.swift", ".swift", "func f() {}")).toBeUndefined();
    expect(extractAst("s.dart", ".dart", "void f() {}")).toBeUndefined();
  });

  it("falls back (undefined) rather than throwing on unparseable input", () => {
    // Deeply broken source must never throw — the engine degrades to regex.
    const r = extractAst("broken.ts", ".ts", "export class {{{ <<< not valid");
    expect(r === undefined || Array.isArray(r.symbols)).toBe(true);
  });
});

const callNames = (rel: string, ext: string, src: string) =>
  (extractAst(rel, ext, src)?.calls ?? []).map((c) => c.name);

describe("AST call-site + imported-name collection", () => {
  it("collects TS function/member/constructor calls, line numbers, and named imports", () => {
    const src = [
      "import { foo, bar as baz } from './m';",
      "export function run() {",
      "  foo();",
      "  obj.method();",
      "  return new Widget();",
      "}",
    ].join("\n");
    const res = extractAst("a.ts", ".ts", src)!;
    const names = res.calls.map((c) => c.name);
    expect(names).toContain("foo"); // call_expression, plain callee
    expect(names).toContain("method"); // call_expression, member callee → rightmost
    expect(names).toContain("Widget"); // new_expression → constructed type
    expect(res.calls.find((c) => c.name === "foo")!.line).toBe(3);
    // The `name` field of each specifier — the pre-alias name for `bar as baz`.
    expect(res.importedNames).toContain("foo");
    expect(res.importedNames).toContain("bar");
  });

  it("collects Python function and attribute-method calls (function mode)", () => {
    const names = callNames("m.py", ".py", "def run():\n    helper()\n    obj.compute()\n");
    expect(names).toContain("helper");
    expect(names).toContain("compute");
    // Non-JS/TS files carry an empty importedNames set (the gate is JS/TS-only).
    expect(extractAst("m.py", ".py", "def r():\n    pass\n")!.importedNames).toEqual([]);
  });

  it("collects Go calls including the rightmost selector segment (function mode)", () => {
    const names = callNames("g.go", ".go", "package p\nfunc run() {\n\tfmt.Println(DoThing())\n}\n");
    expect(names).toContain("Println");
    expect(names).toContain("DoThing");
  });

  it("collects Java method invocations and object creations (function + constructor)", () => {
    const src = "package p;\npublic class S {\n  void run() {\n    compute();\n    obj.doIt();\n    new Widget();\n  }\n}\n";
    const names = callNames("S.java", ".java", src);
    expect(names).toContain("compute");
    expect(names).toContain("doIt");
    expect(names).toContain("Widget");
  });

  it("collects PHP function, member-call, and constructor calls (member mode)", () => {
    const src = "<?php\nfunction run() {\n  helper();\n  $obj->doIt();\n  new Widget();\n}\n";
    const names = callNames("a.php", ".php", src);
    expect(names).toContain("helper");
    expect(names).toContain("doIt");
    expect(names).toContain("Widget");
  });

  it("collects Ruby calls (dotted, parenthesized, and bare command form)", () => {
    const names = callNames("r.rb", ".rb", "def run\n  helper()\n  obj.compute\n  render partial\nend\n");
    expect(names).toContain("helper");
    expect(names).toContain("compute");
    expect(names).toContain("render");
  });

  it("keeps one-letter callees, drops `_` and computed callees, and has no calls for a regex-fallback language", () => {
    // `x()` is a name like any other (the binder discards what nothing
    // defines); `_` is a discard or gettext's alias; a bracket/computed call has
    // no static name.
    const names = callNames("a.ts", ".ts", "export function r() {\n  x();\n  _('msg');\n  tbl['k']();\n  ok();\n}\n");
    expect(names).toEqual(["ok", "x"]);
    // Swift has no committed grammar → extractAst is undefined, so no calls.
    expect(extractAst("s.swift", ".swift", "f()")).toBeUndefined();
  });

  it("honors opts.maxCalls as the per-file call-site cap (issue #10)", () => {
    const src = "export function run() {\n  alpha();\n  bravo();\n  charlie();\n  delta();\n}\n";
    // Default: all four distinct call sites survive.
    expect(extractAst("caps.ts", ".ts", src)!.calls.length).toBe(4);
    // Capped: at most 2 — dedup/sort semantics unchanged, then sliced.
    expect(extractAst("caps.ts", ".ts", src, { maxCalls: 2 })!.calls.length).toBeLessThanOrEqual(2);
  });

  // tsgo's parser.go kept 512 of its 2,748 call sites and every one was an
  // exported (uppercase) call: the cap sliced the NAME-sorted list, and
  // code-unit order puts `Z` before `a`. `parseStatement` had no caller.
  it("keeps one site per distinct callee, in source order, before filling the cap", () => {
    const src = ["export function run() {", "  Alpha();", "  Alpha();", "  Alpha();", "  Bravo();", "  Bravo();", "  lower();", "  zulu();", "}"].join(
      "\n",
    );
    const sites = (max: number) => extractAst("caps.ts", ".ts", src, { maxCalls: max })!.calls.map((c) => `${c.name}@${c.line}`);
    expect(sites(4)).toEqual(["Alpha@2", "Bravo@5", "lower@7", "zulu@8"]);
    expect(sites(6)).toEqual(["Alpha@2", "Alpha@3", "Alpha@4", "Bravo@5", "lower@7", "zulu@8"]);
    expect(sites(2)).toEqual(["Alpha@2", "Bravo@5"]);
    // The regex tier keeps the very same sites.
    const regex = collectCallsRegex(src, [], 4).map((c) => `${c.name}@${c.line}`);
    expect(regex).toEqual(sites(4));
  });

  it("truncates referenced identifiers and named imports in source order, not name order", () => {
    const ids = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(3, "0")}`);
    const src = [
      // Four-letter import names stay under the idents' five-letter floor.
      `import { ${[...ids("z", 150), ...ids("a", 150)].join(", ")} } from "./names";`,
      `use(${[...ids("lower", 300), ...ids("Upper", 300)].join(", ")});`,
    ].join("\n");
    const r = extractAst("big.ts", ".ts", src)!;
    // 512 idents: every lowercase one written first, then the first 212 Upper*.
    expect(r.idents).toHaveLength(512);
    expect(r.idents).toContain("lower299");
    expect(r.idents).toContain("Upper211");
    expect(r.idents).not.toContain("Upper212");
    expect(r.idents).toEqual([...r.idents].sort());
    // 256 imported names: all 150 z*, then the first 106 a*.
    expect(r.importedNames).toHaveLength(256);
    expect(r.importedNames).toContain("z149");
    expect(r.importedNames).toContain("a105");
    expect(r.importedNames).not.toContain("a106");
  });
});

describe("Scala AST extraction", () => {
  const src = [
    "package com.acme.app",
    "",
    "object Registry {",
    "  val limit: Int = 10",
    "  def register(name: String): Unit = {",
    "    helper(name)",
    "    store.save(name)",
    "    val w = new Widget(name)",
    "  }",
    "  private def helper(n: String): Unit = println(n)",
    "}",
    "",
    "case class Point(x: Int, y: Int)",
    "",
    "trait Shape {",
    "  def area(): Double",
    "}",
    "",
    "class Widget(name: String) {",
    "  protected def hidden(): Int = 1",
    "  def render(): String = name",
    "}",
  ].join("\n");

  it("extracts objects/classes/traits/defs/vals with parent nesting and private/protected visibility", () => {
    const syms = extractAst("R.scala", ".scala", src)!.symbols;
    const registry = syms.find((s) => s.name === "Registry")!;
    expect(registry.kind).toBe("object");
    expect(registry.exported).toBe(true);
    const register = syms.find((s) => s.name === "register")!;
    expect(register.kind).toBe("def");
    expect(register.parent).toBe("Registry");
    expect(register.exported).toBe(true);
    expect(syms.find((s) => s.name === "helper")!.exported).toBe(false); // private def
    const limit = syms.find((s) => s.name === "limit")!;
    expect(limit.kind).toBe("val");
    expect(limit.parent).toBe("Registry");
    expect(syms.find((s) => s.name === "Point")!.kind).toBe("class"); // case class
    expect(syms.find((s) => s.name === "Shape")!.kind).toBe("trait");
    expect(syms.find((s) => s.name === "area")!.parent).toBe("Shape"); // abstract def
    expect(syms.find((s) => s.name === "hidden")!.exported).toBe(false); // protected def
    expect(syms.find((s) => s.name === "render")!.exported).toBe(true);
  });

  it("collects calls incl. a qualified call with receiver and a constructor", () => {
    const res = extractAst("R.scala", ".scala", src)!;
    const names = res.calls.map((c) => c.name);
    expect(names).toContain("helper"); // bare call
    const save = res.calls.find((c) => c.name === "save")!;
    expect(save.receiver).toBe("store"); // field_expression value → receiver
    expect(names).toContain("Widget"); // instance_expression → constructed type
  });

  it("upgrades .scala/.sc from the regex tier: extractAst is now defined", () => {
    // Before this grammar shipped, extractAst returned undefined for scala.
    expect(extractAst("a.scala", ".scala", "object A { def f(): Int = 1 }")).toBeDefined();
    expect(extractAst("a.sc", ".sc", "def f(): Int = 1")).toBeDefined();
  });
});

describe("Bash AST extraction", () => {
  const src = [
    "#!/usr/bin/env bash",
    "",
    "function setup {",
    "  echo start",
    "}",
    "",
    "teardown() {",
    "  echo stop",
    "}",
    "",
    "if true; then",
    "  guarded() {",
    "    echo hi",
    "  }",
    "fi",
    "",
    "setup",
    'git commit -m "x"',
  ].join("\n");

  it("extracts both function syntaxes (always exported), incl. an if-guarded definition", () => {
    const syms = extractAst("run.sh", ".sh", src)!.symbols;
    for (const name of ["setup", "teardown", "guarded"]) {
      const s = syms.find((x) => x.name === name)!;
      expect(s.kind).toBe("function");
      expect(s.exported).toBe(true); // shell has no visibility — always exported
    }
  });

  it("collects command invocations as calls (word leaf under command_name), no receivers", () => {
    const res = extractAst("run.sh", ".sh", src)!;
    const setup = res.calls.find((c) => c.name === "setup")!;
    expect(setup.line).toBe(17);
    expect(setup.receiver).toBeUndefined(); // shell calls are never qualified
    expect(res.calls.map((c) => c.name)).toContain("git");
  });

  it("upgrades .sh/.bash from the regex tier: extractAst is now defined", () => {
    expect(extractAst("a.sh", ".sh", "f() {\n  echo hi\n}\n")).toBeDefined();
    expect(extractAst("a.bash", ".bash", "f() {\n  echo hi\n}\n")).toBeDefined();
  });
});

describe("Lua AST extraction", () => {
  const src = [
    "local M = {}",
    "",
    "local function hidden(x)",
    "  return x + 1",
    "end",
    "",
    "function M.add(a, b)",
    "  return hidden(a) + b",
    "end",
    "",
    "function M:method(v)",
    "  self.value = v",
    "end",
    "",
    "M.alias = function(z)",
    "  return z",
    "end",
    "",
    "function top(n)",
    "  print(n)",
    '  string.format("%d", n)',
    "  obj:send(n)",
    "end",
    "",
    "return M",
  ].join("\n");

  it("extracts declaration- and assignment-style functions; `local function` is not exported", () => {
    const syms = extractAst("m.lua", ".lua", src)!.symbols;
    expect(syms.find((s) => s.name === "hidden")!.exported).toBe(false); // local function → file-local
    // A table function is the table's member: named by its last segment (what
    // a call site records), parented to the table.
    expect(syms.find((s) => s.name === "add" && s.parent === "M")!.exported).toBe(true);
    expect(syms.find((s) => s.name === "method" && s.parent === "M")!.exported).toBe(true); // colon method form
    expect(syms.some((s) => /[.:]/.test(s.name))).toBe(false);
    const alias = syms.find((s) => s.name === "alias" && s.parent === "M")!; // assignment-style def
    expect(alias.kind).toBe("function");
    expect(alias.line).toBe(15);
    expect(alias.endLine).toBe(17);
    expect(alias.exported).toBe(true);
    expect(syms.find((s) => s.name === "top")!.exported).toBe(true);
    // `self.value = v` (inside a body) and `local M = {}` are not symbols.
    expect(syms.some((s) => s.name === "self.value")).toBe(false);
    expect(syms.some((s) => s.name === "M")).toBe(false);
  });

  it("collects calls incl. dot- and colon-qualified receivers", () => {
    const res = extractAst("m.lua", ".lua", src)!;
    expect(res.calls.map((c) => c.name)).toContain("hidden");
    expect(res.calls.find((c) => c.name === "format")!.receiver).toBe("string"); // dot_index table
    expect(res.calls.find((c) => c.name === "send")!.receiver).toBe("obj"); // method_index table
  });

  it("upgrades .lua from the regex tier: extractAst is now defined", () => {
    // This exact shape was the old "no committed grammar" fallback assertion.
    expect(extractAst("s.lua", ".lua", "function f() end")).toBeDefined();
  });
});

describe("CommonJS assignment-style definitions (JS/TS)", () => {
  it("extracts res.x / prototype / exports assignments of functions with endLine", () => {
    const src = [
      "var res = {};",
      "",
      "res.sendStatus = function sendStatus(statusCode) {",
      "  statusCode = Number(statusCode);",
      "  return statusCode;",
      "};",
      "",
      "Thing.prototype.render = function () {",
      "  return 1;",
      "};",
      "",
      "exports.helper = function helper() {",
      "  return 2;",
      "};",
      "",
      "module.exports.other = () => 3;",
      "",
      "res.count = 1;",
    ].join("\n");
    const syms = extractAst("lib/response.js", ".js", src)!.symbols;

    const send = syms.find((s) => s.name === "sendStatus")!;
    expect(send.kind).toBe("function");
    expect(send.line).toBe(3);
    expect(send.endLine).toBe(6);
    expect(send.exported).toBe(false); // augmenting a local object is not a module export

    const render = syms.find((s) => s.name === "render")!;
    expect(render.line).toBe(8);
    expect(render.endLine).toBe(10);

    expect(syms.find((s) => s.name === "helper")!.exported).toBe(true);
    expect(syms.find((s) => s.name === "other")!.exported).toBe(true);

    // A plain value assignment is NOT a symbol (would be pure noise).
    expect(syms.some((s) => s.name === "count")).toBe(false);
  });
});
