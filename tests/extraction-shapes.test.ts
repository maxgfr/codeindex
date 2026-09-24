import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCallerIndex } from "../src/callers.js";
import { scanRepo } from "../src/scan.js";
import { extractAst } from "../src/ast/extract.js";
import { grammarKeyFor, grammarKeysForExts, grammarReady } from "../src/ast/loader.js";
import type { CodeSymbol } from "../src/types.js";

// Declaration SHAPES the AST walk mishandled, one describe per shape. Each was
// measured on a real repository before it was fixed (numbers in the comments);
// the labelled quality fixtures carry the same shapes so the ratchet guards them
// too. Grammars are warmed by tests/setup.ts.

const syms = (rel: string, src: string): CodeSymbol[] => {
  const ext = rel.slice(rel.lastIndexOf("."));
  return extractAst(rel, ext, src)?.symbols ?? [];
};
const find = (all: CodeSymbol[], name: string, parent?: string): CodeSymbol | undefined =>
  all.find((s) => s.name === name && (parent === undefined || s.parent === parent));
const ids = (all: CodeSymbol[]): string[] => all.map((s) => (s.parent ? `${s.parent}.${s.name}` : s.name));

describe("a doc comment separated from its item by attributes", () => {
  // memchr: 457 of 1187 symbols carry a `///` doc above `#[inline]`/`#[derive]`,
  // and every one of them lost it.
  it("reaches a Rust item across outer attributes", () => {
    const all = syms(
      "lib.rs",
      [
        "/// A scheduler.",
        "#[derive(Debug, Clone)]",
        '#[cfg_attr(feature = "serde", derive(Serialize))]',
        "pub struct Scheduler {",
        "    /// The queue.",
        "    #[serde(default)]",
        "    pub queue: Vec<u8>,",
        "}",
        "",
        "/// Fast path.",
        "#[inline]",
        "pub fn fast() {}",
      ].join("\n"),
    );
    expect(find(all, "Scheduler")?.doc).toBe("A scheduler.");
    expect(find(all, "queue", "Scheduler")?.doc).toBe("The queue.");
    expect(find(all, "fast")?.doc).toBe("Fast path.");
  });

  it("joins doc lines interleaved with attributes, as rustdoc does", () => {
    const all = syms("lib.rs", ["/// Spans", "#[inline]", "/// two lines.", "fn f() {}"].join("\n"));
    expect(find(all, "f")?.doc).toBe("Spans two lines.");
  });

  it("still refuses a comment a blank line away, and one above an inner attribute", () => {
    const all = syms(
      "lib.rs",
      ["// Copyright header.", "", "#[cfg(test)]", "mod tests {}", "", "//! Crate docs.", "#![allow(dead_code)]", "fn g() {}"].join(
        "\n",
      ),
    );
    expect(find(all, "tests")?.doc).toBeUndefined();
    expect(find(all, "g")?.doc).toBeUndefined();
  });

  it("reaches a TypeScript class member across a decorator on its own line", () => {
    const all = syms(
      "a.ts",
      ["export class A {", "  /** Handles x. */", '  @HostListener("x")', "  onX() {}", "}"].join("\n"),
    );
    expect(find(all, "onX", "A")?.doc).toBe("Handles x.");
  });
});

describe("Python declarations under if / try / with / match", () => {
  // flask/globals.py declares seven classes under `if t.TYPE_CHECKING:`; the
  // regex tier found them and the AST tier did not.
  const src = [
    "from typing import TYPE_CHECKING",
    "try:",
    "    import ujson as json",
    "except ImportError:",
    "    json = None",
    "    def fallback_loads(s):",
    '        """Fallback loader."""',
    "if TYPE_CHECKING:",
    "    class FlaskProxy:",
    "        def _get_current_object(self): ...",
    "elif X:",
    "    def on_elif(): pass",
    "else:",
    "    def on_else(): pass",
    'with open("x") as f:',
    "    DATA = f.read()",
    "match cmd:",
    '    case "a":',
    "        def on_case(): pass",
    "def outer():",
    "    if flag:",
    "        def inner(): pass",
    "    local = 1",
    'if __name__ == "__main__":',
    "    parser = make_parser()",
    "    def cli(): pass",
  ].join("\n");
  const all = syms("mod.py", src);

  it("finds definitions in every compound-statement branch", () => {
    expect(find(all, "fallback_loads")?.doc).toBe("Fallback loader.");
    expect(find(all, "FlaskProxy")?.kind).toBe("class");
    expect(find(all, "_get_current_object", "FlaskProxy")?.exported).toBe(false);
    for (const name of ["on_elif", "on_else", "on_case"]) expect(find(all, name)?.kind, name).toBe("function");
  });

  it("keeps module-scope assignments inside a block as constants", () => {
    expect(find(all, "json")?.kind).toBe("const");
    expect(find(all, "DATA")?.kind).toBe("const");
  });

  it("keeps a nested function a nested function, and a local a local", () => {
    expect(find(all, "inner", "outer")?.exported).toBe(false);
    expect(find(all, "local")).toBeUndefined();
  });

  it("does not index what a __main__ guard assigns", () => {
    expect(find(all, "parser")).toBeUndefined();
    expect(find(all, "cli")?.kind).toBe("function");
  });
});

describe("visibility is read from the modifiers, not the whole header", () => {
  const exp = (rel: string, src: string, name: string): boolean | undefined => find(syms(rel, src), name)?.exported;

  it("ignores keywords that are parameter names or default values", () => {
    const php = "<?php\nclass A {\n  public function setPrivate(bool $private): void {}\n  public function count(int $protected = 0): int { return 0; }\n}";
    expect(exp("A.php", php, "setPrivate")).toBe(true);
    expect(exp("A.php", php, "count")).toBe(true);
    const java = "class B {\n  void register(Object internal) {}\n  private int x(int publicId) { return 0; }\n}";
    expect(exp("B.java", java, "register")).toBe(false);
    expect(exp("B.java", java, "x")).toBe(false);
    const cs = 'class D {\n  void Log(string msg = "public api") {}\n  public void Show(string internalNote) {}\n}';
    expect(exp("D.cs", cs, "Log")).toBe(false);
    expect(exp("D.cs", cs, "Show")).toBe(true);
    const scala = 'object C {\n  def configure(cfg: Map[String, String] = Map("x" -> "private")): Unit = ()\n}';
    expect(exp("C.scala", scala, "configure")).toBe(true);
  });

  it("does not let one private constructor parameter hide the whole class", () => {
    const scala = syms("S.scala", "class Svc(val name: String, private val secret: Int)");
    expect(find(scala, "Svc")?.exported).toBe(true);
    expect(find(scala, "name", "Svc")?.exported).toBe(true);
    expect(find(scala, "secret", "Svc")?.exported).toBe(false);
    const kotlin = syms("K.kt", "class Creds(val user: String, private val secret: String, @Transient var z: Int, plain: Int)");
    expect(find(kotlin, "Creds")?.exported).toBe(true);
    expect(find(kotlin, "secret", "Creds")?.exported).toBe(false);
    expect(find(kotlin, "z", "Creds")?.kind).toBe("property");
    expect(find(kotlin, "plain")).toBeUndefined();
    const php = syms("R.php", "<?php\nclass Repo {\n  public function __construct(private readonly Db $db) {}\n}");
    expect(find(php, "__construct", "Repo")?.exported).toBe(true);
  });

  it("does not mistake an annotation argument for the name (the JPA idiom)", () => {
    const java = 'class E {\n  @Column(name = "name") private String name;\n  @Column(name = "id") public Long id;\n}';
    expect(exp("E.java", java, "name")).toBe(false);
    expect(exp("E.java", java, "id")).toBe(true);
  });

  it("still reads Solidity's visibility, which follows the parameter list", () => {
    const sol = "contract C {\n  function a() internal {}\n  function b() external {}\n}";
    expect(exp("C.sol", sol, "a")).toBe(false);
    expect(exp("C.sol", sol, "b")).toBe(true);
  });
});

describe("Go type aliases", () => {
  it("indexes top-level and grouped `type X = Y`, docs included", () => {
    const all = syms(
      "a.go",
      ["package x", "type (", "\tA struct{}", "\t// B is an int.", "\tB = int", "\tc = int", ")", "// C names a string.", "type C = string"].join(
        "\n",
      ),
    );
    expect(find(all, "B")).toMatchObject({ kind: "type", exported: true, doc: "B is an int." });
    expect(find(all, "c")).toMatchObject({ kind: "type", exported: false });
    expect(find(all, "C")).toMatchObject({ kind: "type", doc: "C names a string.", signature: "C = string" });
  });
});

describe("C typedef'd structs and macros", () => {
  const src = [
    "#ifndef SCHED_H",
    "#define SCHED_H",
    "",
    "/** Upper bound. */",
    "#define MAX_JOBS 64",
    "#define SQUARE(x) ((x) * (x))",
    "#ifndef API",
    "#define API",
    "#endif",
    "",
    "/** A job. */",
    "typedef struct job {",
    "    int id;",
    "    void (*run)(struct job *);",
    "} job_t;",
    "",
    "typedef enum { IDLE, RUNNING } state_t;",
    "typedef struct cJSON { int type; } cJSON;",
    "typedef struct opaque opaque_t;",
    "#endif",
  ].join("\n");
  const all = syms("sched.h", src);

  it("walks a typedef'd body, parenting members to the typedef name", () => {
    expect(find(all, "id", "job_t")?.kind).toBe("field");
    // A function-pointer member: its name sits behind a parenthesized_declarator.
    expect(find(all, "run", "job_t")?.kind).toBe("method");
    expect(find(all, "IDLE", "state_t")?.kind).toBe("enum-member");
    expect(find(all, "RUNNING", "state_t")?.kind).toBe("enum-member");
    expect(find(all, "type", "cJSON")?.kind).toBe("field");
  });

  it("emits the struct tag beside the typedef, but never twice and never for an opaque typedef", () => {
    expect(find(all, "job")).toMatchObject({ kind: "struct", doc: "A job." });
    expect(all.filter((s) => s.name === "cJSON").map((s) => s.kind)).toEqual(["type"]);
    expect(find(all, "opaque")).toBeUndefined();
  });

  it("indexes #define macros but not the include guard", () => {
    expect(find(all, "MAX_JOBS")).toMatchObject({ kind: "macro", doc: "Upper bound.", signature: "#define MAX_JOBS 64", line: 5, endLine: 5 });
    expect(find(all, "SQUARE")?.kind).toBe("macro");
    // `#ifndef API / #define API / #endif` wraps nothing else: a real default.
    expect(find(all, "API")?.kind).toBe("macro");
    expect(find(all, "SCHED_H")).toBeUndefined();
  });
});

describe("C++ out-of-line definitions, operators and reference returns", () => {
  it("parents an out-of-line member to its class, not the enclosing namespace", () => {
    const all = syms(
      "a.cpp",
      [
        "namespace acme {",
        "void Widget::draw() const {}",
        "Widget::Widget() {}",
        "Widget::~Widget() {}",
        "void Outer::Inner::deep() {}",
        "template <typename T> T Box<T>::get() const { return v; }",
        "const std::string& Widget::name() const { return n; }",
        "int Widget::count = 0;",
        "void free_fn() {}",
        "}",
        "void ::global_fn() {}",
      ].join("\n"),
    );
    expect(ids(all)).toEqual([
      "acme",
      "Widget.draw",
      "Widget.Widget",
      "Widget.~Widget",
      "Inner.deep",
      "Box.get",
      "Widget.name",
      "Widget.count",
      "acme.free_fn",
      "global_fn",
    ]);
  });

  it("names operators, conversions, destructors and reference-returning members", () => {
    const all = syms(
      "w.hpp",
      [
        "class Widget {",
        " public:",
        "  virtual ~Widget();",
        "  explicit operator bool() const;",
        "  operator char *() const;",
        "  bool operator == (const Widget& o) const;",
        "  void* operator new[](size_t n);",
        "  Widget& operator=(const Widget&) = default;",
        "  const std::string& name() const;",
        "};",
        "int operator+(const Widget& a, const Widget& b) { return 0; }",
      ].join("\n"),
    );
    expect(ids(all)).toEqual([
      "Widget",
      "Widget.~Widget",
      "Widget.operator bool",
      "Widget.operator char*",
      "Widget.operator==",
      "Widget.operator new[]",
      "Widget.operator=",
      "Widget.name",
      "operator+",
    ]);
    expect(find(all, "operator bool")?.kind).toBe("function");
  });

  it("names C# operators by their token and indexers by `this[]`", () => {
    const all = syms(
      "S.cs",
      [
        "class Svc {",
        "  public static Svc operator +(Svc a, Svc b) => a;",
        "  public static bool operator true(Svc a) => true;",
        "  public int this[int i] => i;",
        "}",
      ].join("\n"),
    );
    expect(ids(all)).toEqual(["Svc", "Svc.operator+", "Svc.operator true", "Svc.this[]"]);
    expect(find(all, "this[]")?.kind).toBe("indexer");
  });

  it("reads a generic base as the base, not its type argument", () => {
    const rels = (rel: string, src: string) =>
      (extractAst(rel, rel.slice(rel.lastIndexOf(".")), src)?.relations ?? []).map((r) => `${r.kind} ${r.from} ${r.to}`);
    expect(rels("a.cs", "class A : Base<Foo>, IThing<Bar> {}")).toEqual(["extends A Base", "implements A IThing"]);
    expect(rels("b.cpp", "class B : public Base<Foo> {};")).toEqual(["extends B Base"]);
  });
});

describe("a C++ header named .h", () => {
  // leveldb's 56 headers: 142 symbols parsed as C, 963 as C++ (the regex tier
  // found 145). A pure C header must stay on the C grammar: cJSON's lose a
  // third of their symbols when read as C++.
  it("is parsed as C++ when its content says so, as C otherwise", () => {
    expect(grammarKeyFor(".h", "namespace leveldb {\nclass DB;\n}")).toBe("cpp");
    expect(grammarKeyFor(".h", "class LEVELDB_EXPORT DB {\n public:\n};")).toBe("cpp");
    expect(grammarKeyFor(".h", "template <typename T>\nT max(T a, T b);")).toBe("cpp");
    expect(grammarKeyFor(".h", "#include <string>\nstd::string f();")).toBe("cpp");
    expect(grammarKeyFor(".h", '#ifdef __cplusplus\nextern "C" {\n#endif\nint f(void);')).toBe("c");
    expect(grammarKeyFor(".h", "/* This structure describes the\n   class of the device.  */\nint f(int new);")).toBe("c");
    expect(grammarKeyFor(".c", "namespace x {}")).toBe("c");
  });

  it("indexes the class API and keeps the file's own language on every symbol", () => {
    const all = syms("db.h", "namespace leveldb {\nclass DB {\n public:\n  virtual Status Put(const Slice& key) = 0;\n};\n}");
    expect(ids(all)).toEqual(["leveldb", "leveldb.DB", "DB.Put"]);
    expect(find(all, "leveldb")?.kind).toBe("namespace");
    expect(new Set(all.map((s) => s.lang))).toEqual(new Set(["c"]));
  });

  it("warms the C++ grammar for any repo with a .h, so output never depends on the other files", () => {
    expect(grammarKeysForExts([".h"])).toEqual(["c", "cpp"]);
  });
});

describe("a module's default export bound to a function or class value", () => {
  const rels = (rel: string, src: string) =>
    (extractAst(rel, rel.slice(rel.lastIndexOf(".")), src)?.relations ?? []).map((r) => `${r.kind} ${r.from} ${r.to}`);

  // The dominant export style of Express middleware, webpack loaders and ESLint
  // rules read as a private function named "exports", its class body unwalked.
  it("names `module.exports = …` after the value, else the file stem, and exports it", () => {
    const named = syms("mw.js", "module.exports = function middleware(req, res) {};");
    expect(named.map((s) => [s.name, s.kind, s.exported])).toEqual([["middleware", "function", true]]);
    const anon = syms("mw.js", "module.exports = async (req, res) => { function inner() {} };");
    expect(anon.map((s) => [ids([s])[0], s.kind, s.exported])).toEqual([
      ["mw", "function", true],
      ["mw.inner", "function", false],
    ]);
    const cls = syms("cls.js", "module.exports = class Foo extends Base { bar() {} };");
    expect(ids(cls)).toEqual(["Foo", "Foo.bar"]);
    expect(cls.every((s) => s.exported)).toBe(true);
    expect(rels("cls.js", "module.exports = class Foo extends Base { bar() {} };")).toEqual(["extends Foo Base"]);
  });

  it("walks the class an `exports.x =` assignment binds", () => {
    const all = syms("ex.js", "exports.Store = class { save() {} };\nexports.helper = function () { function nested() {} };");
    expect(ids(all)).toEqual(["Store", "Store.save", "helper", "helper.nested"]);
    expect(find(all, "nested")?.exported).toBe(false);
  });

  it("walks an anonymous `export default class` and hangs its members off the stem", () => {
    const all = syms("Card.tsx", "export default class extends React.Component {\n  render() { return null; }\n  private tick() {}\n}");
    expect(ids(all)).toEqual(["Card", "Card.render", "Card.tick"]);
    expect(find(all, "render")?.exported).toBe(true);
    expect(find(all, "tick")?.exported).toBe(false);
    expect(rels("Card.tsx", "export default class extends React.Component {}")).toEqual(["extends Card Component"]);
    expect(ids(syms("widget.ts", "export default function () { function inner() {} }"))).toEqual(["widget", "widget.inner"]);
  });

  it("reads a JavaScript superclass, which its grammar writes without a clause node", () => {
    expect(rels("a.js", "class A extends B {}\nclass C extends mixin(D) {}")).toEqual(["extends A B", "extends C mixin"]);
    // A class expression inside a function is bound to nothing the walk knows,
    // so it must not state a relation about the function.
    expect(rels("f.js", "function make() { return class extends Base {}; }")).toEqual([]);
  });
});

describe("an Elixir definition with a guard", () => {
  // `def f(x) when …` wraps the head in a `when` operator, so the name reader
  // found no call there and every guarded clause — and every `defguard`, which
  // always has one — was dropped, while its head registered as a call site.
  it.skipIf(!grammarReady("elixir"))("is indexed under its own name, and its head is not a call", () => {
    const src = [
      "defmodule M do",
      "  defguard is_pos(x) when is_integer(x) and x > 0",
      "  defguardp is_small(x) when x < 10",
      "  def pub(x) when is_pos(x) do",
      "    x",
      "  end",
      "  defp hidden(x) when is_integer(x), do: x",
      "  defmacro m(x) when is_atom(x), do: x",
      "  def a <~> b, do: a",
      "end",
    ].join("\n");
    const r = extractAst("m.ex", ".ex", src)!;
    expect(r.symbols.map((s) => [ids([s])[0], s.kind, s.exported])).toEqual([
      ["M", "module", true],
      ["M.is_pos", "guard", true],
      ["M.is_small", "guard", false],
      ["M.pub", "function", true],
      ["M.hidden", "function", false],
      ["M.m", "macro", true],
      ["M.<~>", "function", true],
    ]);
    expect(r.calls.map((c) => `${c.name}:${c.line}`)).toEqual(["is_atom:8", "is_integer:2", "is_integer:7", "is_pos:4"]);
  });
});

describe("a Lua function stored in a table", () => {
  // Named "M.go" whole, it never met its call sites, which record `u.go()` as
  // "go": no module function had a caller, and deadcode flagged every one.
  it("is the table's member, named by its last segment", () => {
    const src = [
      "local M = {}",
      "function M.go() end",
      "function M:start(a) end",
      "function M.sub.deep() end",
      "M.alias, M.sub.other = function() end, function() end",
      "M[key] = function() end",
      "local function helper() end",
      "return M",
    ].join("\n");
    expect(syms("u.lua", src).map((s) => [s.parent, s.name, s.exported])).toEqual([
      ["M", "go", true],
      ["M", "start", true],
      ["M.sub", "deep", true],
      ["M", "alias", true],
      ["M.sub", "other", true],
      [undefined, "helper", false],
    ]);
  });

  it("binds the caller of a required module's function", () => {
    const dir = mkdtempSync(join(tmpdir(), "lua-"));
    try {
      mkdirSync(join(dir, "lib"));
      writeFileSync(join(dir, "lib", "u.lua"), "local M = {}\nfunction M.go() end\nreturn M\n");
      writeFileSync(join(dir, "init.lua"), 'local u = require("lib.u")\nu.go()\n');
      const entry = buildCallerIndex(scanRepo(dir, { gitignore: false })).get("go");
      expect(entry?.def).toMatchObject({ file: "lib/u.lua", parent: "M" });
      expect(entry?.callers).toEqual([expect.objectContaining({ file: "init.lua", line: 2 })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("an export list", () => {
  const exported = (all: CodeSymbol[]) => all.map((s) => `${ids([s])[0]}=${s.exported ? 1 : 0}`);

  // `export { save, helper }` names MODULE bindings. Marking every same-named
  // symbol published a `private` method and a function's local, which then
  // became call-resolution candidates and dropped out of deadcode.
  it("marks only the bindings of the scope it is written in", () => {
    const src = [
      "class Store {",
      "  private save(): void {}",
      "}",
      "function save(): void {}",
      "function outer() {",
      "  function helper() {}",
      "}",
      "function helper() {}",
      "export { save, helper };",
    ].join("\n");
    expect(exported(syms("a.ts", src))).toEqual(["Store=0", "Store.save=0", "save=1", "outer=0", "outer.helper=0", "helper=1"]);
    const ambient = 'module "m" {\n  function g(): void;\n  function h(): void;\n  export { g };\n}\nfunction g() {}';
    expect(exported(syms("m.ts", ambient))).toEqual(['"m"=0', '"m".g=1', '"m".h=0', "g=0"]);
  });

  it("re-exporting another module's binding marks nothing declared here", () => {
    expect(exported(syms("r.ts", 'const a = 1;\nexport { a } from "./other";'))).toEqual(["a=0"]);
    expect(exported(syms("c.js", "function foo() {}\nclass K { foo() {} }\nmodule.exports = { foo };"))).toEqual([
      "foo=1",
      "K=0",
      "K.foo=0",
    ]);
  });
});

describe("a constructor parameter that declares a property", () => {
  const props = (all: CodeSymbol[]) =>
    all.filter((s) => s.kind === "property").map((s) => `${ids([s])[0]}:${s.line}=${s.exported ? 1 : 0} ${s.signature}`);

  // NestJS/Angular inject every dependency this way, and PHP 8 promotes the
  // same way; neither declares the property anywhere else.
  it("is a TypeScript class property when it carries a modifier", () => {
    const src = [
      "export class Service {",
      "  constructor(",
      "    private readonly dep: Dep,",
      "    public pub: string,",
      "    plain: number,",
      "    protected prot?: number,",
      "    override readonly o = 1,",
      "  ) {}",
      "  run(x: number) {}",
      "}",
      "function f() { class Local { constructor(public q: number) {} } }",
    ].join("\n");
    expect(props(syms("s.ts", src))).toEqual([
      "Service.dep:3=0 private readonly dep: Dep",
      "Service.pub:4=1 public pub: string",
      "Service.prot:6=0 protected prot?: number",
      "Service.o:7=1 override readonly o = 1",
    ]);
  });

  it("is a PHP class property when the constructor promotes it", () => {
    const src = [
      "<?php",
      "class Svc {",
      "    public function __construct(",
      "        private readonly Repo $repo,",
      "        public string $name = '',",
      "        int $plain = 0,",
      "    ) {}",
      "    public function run(public int $x) {}",
      "}",
    ].join("\n");
    expect(props(syms("Svc.php", src))).toEqual(["Svc.repo:4=0 private readonly Repo $repo", "Svc.name:5=1 public string $name = ''"]);
  });
});

describe("a Python module that declares `__all__`", () => {
  const vis = (all: CodeSymbol[]) => all.map((s) => `${s.kind} ${ids([s])[0]}=${s.exported ? 1 : 0}`);

  // `__all__` is the surface `from m import *` exports and API docs publish;
  // the underscore rule only guesses at it.
  it("decides its top-level names' visibility; members keep the convention", () => {
    const src = [
      "from .decoder import JSONDecoder, Other",
      "from .app import Flask as Flask",
      "__all__ = ['Service', 'CONST', '_listed', 'JSONDecoder']",
      "if sys.platform == 'win32':",
      "    __all__.append('win_only')",
      "__all__.extend(('ext',))",
      "CONST = 5",
      "OTHER = 1",
      "_listed = 2",
      "def helper(): ...",
      "def win_only(): ...",
      "def ext(): ...",
      "class Service:",
      "    def run(self): ...",
      "    def _hidden(self): ...",
    ].join("\n");
    expect(vis(syms("mod.py", src))).toEqual([
      "reexport JSONDecoder=1",
      "reexport Flask=0",
      "const __all__=0",
      "const CONST=1",
      "const OTHER=0",
      "const _listed=1",
      "function helper=0",
      "function win_only=1",
      "function ext=1",
      "class Service=1",
      "function Service.run=1",
      "function Service._hidden=0",
    ]);
  });

  it("is ignored when computed at runtime, and absent", () => {
    for (const all of ["[n for n in globals() if n[:1] != '_']", "base.__all__ + ['x']"]) {
      expect(vis(syms("m.py", `__all__ = ${all}\nOTHER = 1\n_p = 2`))).toEqual(["const __all__=1", "const OTHER=1", "const _p=0"]);
    }
    expect(vis(syms("m.py", "__all__ = ['a']\n__all__.extend(names())\nOTHER = 1"))).toEqual(["const __all__=1", "const OTHER=1"]);
    expect(vis(syms("m.py", "from .x import Y\nOTHER = 1"))).toEqual(["const OTHER=1"]);
  });
});

describe("Ruby definitions outside a plain class body", () => {
  const vis = (all: CodeSymbol[]) => all.map((s) => `${s.kind} ${ids([s])[0]}=${s.exported ? 1 : 0}`);

  it("indexes `class << self` methods as the class's, in a section of their own", () => {
    const src = [
      "class W",
      "  private",
      "  class << self",
      "    def create; end",
      "    private",
      "    def build; end",
      "  end",
      "  def helper; end",
      "end",
    ].join("\n");
    expect(vis(syms("w.rb", src))).toEqual(["class W=1", "def W.create=1", "def W.build=0", "def W.helper=0"]);
  });

  it("gives a definition wrapped in a visibility call that visibility alone", () => {
    const src = [
      "class W",
      "  # Weighs a job.",
      "  protected def weight; end",
      "  private def self.hidden; end",
      "  private_class_method def self.pcm; end",
      "  private attr_reader :secret",
      "  def open; end",
      "  private",
      "  public def shown; end",
      "  module_function def mf; end",
      "end",
    ].join("\n");
    const all = syms("w.rb", src);
    expect(vis(all)).toEqual([
      "class W=1",
      "def W.weight=0",
      "def W.hidden=0",
      "def W.pcm=0",
      "attr W.secret=0",
      "def W.open=1",
      "def W.shown=1",
      "def W.mf=1",
    ]);
    expect(find(all, "weight")?.doc).toBe("Weighs a job.");
  });

  it("walks the block of a class a factory builds", () => {
    const src = [
      "Point = Struct.new(:x, :y) do",
      "  def dist; end",
      "end",
      "Pair = Struct.new(:a) { def sum; end }",
      "Mixin = Module.new do",
      "  def helper; end",
      "end",
      "Value = Data.define(:v)",
      "LIMIT = Limit.new(5)",
    ].join("\n");
    expect(syms("p.rb", src).map((s) => `${s.kind} ${ids([s])[0]}`)).toEqual([
      "class Point",
      "def Point.dist",
      "class Pair",
      "def Pair.sum",
      "module Mixin",
      "def Mixin.helper",
      "class Value",
      "const LIMIT",
    ]);
  });
});

describe("a Ruby mixin call on another receiver", () => {
  // `klass.extend Mixin` inside a hook mixes into `klass`, not into the method
  // the call sits in; the Ruby stdlib produced "included implements
  // ClassMethods" and "initialize implements TSort" this way.
  it("states no relation about the enclosing declaration", () => {
    const rels = (src: string) => (extractAst("m.rb", ".rb", src)?.relations ?? []).map((r) => `${r.kind} ${r.from} ${r.to}`);
    const src = [
      "module Plugin",
      "  include Base",
      "  self.extend Helpers",
      "  def self.included(klass)",
      "    klass.extend ClassMethods",
      "  end",
      "end",
      "NameError.prepend(Plugin)",
    ].join("\n");
    expect(rels(src)).toEqual(["implements Plugin Base", "implements Plugin Helpers"]);
  });
});

describe("a declaration that binds several names", () => {
  // The single-name readers stopped at the first, so `var a, b` or `int x, y;`
  // indexed `a` and `x` and silently dropped the rest.
  const vis = (rel: string, src: string) => syms(rel, src).map((s) => `${s.kind} ${ids([s])[0]}=${s.exported ? 1 : 0}`);

  it("declares every name it lists, each with its own visibility", () => {
    expect(vis("s.go", "package p\nvar Single, double = 1, 2\nconst A, b = 1, 2\ntype Box struct {\n\ta, B int\n\tEmbedded\n}")).toEqual([
      "package p=0",
      "var Single=1",
      "var double=0",
      "const A=1",
      "const b=0",
      "type Box=1",
      "field Box.a=0",
      "field Box.B=1",
    ]);
    expect(vis("S.java", "class S {\n  private final List<String> items = List.of(), others;\n  public int a = 1, b;\n}")).toEqual([
      "class S=0",
      "field S.items=0",
      "field S.others=0",
      "field S.a=1",
      "field S.b=1",
    ]);
    expect(vis("S.cs", "class S {\n  private List<int> _items = new(), _other;\n  public event EventHandler A, B;\n}")).toEqual([
      "class S=0",
      "field S._items=0",
      "field S._other=0",
      "event S.A=1",
      "event S.B=1",
    ]);
    expect(vis("S.php", "<?php\nclass S {\n  public static int $count = 0, $other = 1;\n  const A = 1, B = 2;\n}")).toEqual([
      "class S=1",
      "property S.count=1",
      "property S.other=1",
      "const S.A=1",
      "const S.B=1",
    ]);
  });

  it("reads each C/C++ declarator to its name", () => {
    expect(vis("p.c", "struct P { int x, *y, z[3]; };\nint ga, *gb;")).toEqual([
      "struct P=1",
      "field P.x=1",
      "field P.y=1",
      "field P.z=1",
      "const ga=1",
      "const gb=1",
    ]);
    expect(vis("p.cpp", "class W {\n public:\n  std::string s, t;\n  int a, &b = a;\n};")).toEqual([
      "class W=1",
      "field W.s=1",
      "field W.t=1",
      "field W.a=1",
      "field W.b=1",
    ]);
  });

  it("binds every Python target of a tuple or chained assignment", () => {
    const src = "a, b = 1, 2\n(c, d) = 3, 4\ng, *rest = [1, 2]\nx, obj.attr = 1, 2\nh = _i = 7\nclass K:\n    lo, hi = 0, 9";
    expect(vis("m.py", src)).toEqual([
      "const a=1",
      "const b=1",
      "const c=1",
      "const d=1",
      "const g=1",
      "const rest=1",
      "const x=1",
      "const h=1",
      "const _i=0",
      "class K=1",
      "field K.lo=1",
      "field K.hi=1",
    ]);
  });
});
