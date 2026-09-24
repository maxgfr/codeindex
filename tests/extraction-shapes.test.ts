import { describe, expect, it } from "vitest";
import { extractAst } from "../src/ast/extract.js";
import { grammarKeyFor, grammarKeysForExts } from "../src/ast/loader.js";
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
