import { describe, expect, it } from "vitest";
import { extractAst } from "../src/ast/extract.js";

// What `signature` holds: the declaration header, from its keyword to its body,
// on one line — and nothing else. Every case below leaked something else into
// it before: a comment, a body with no node of its own, an expression body, a
// formatter's line breaks. Measured on flask, gin, anyhow, cJSON and tsgo: 1,432
// of 24,001 signatures changed, none of them by losing header text. Grammars are
// warmed by tests/setup.ts.

const sigs = (rel: string, src: string): Record<string, string | undefined> => {
  const ext = rel.slice(rel.lastIndexOf("."));
  const out: Record<string, string | undefined> = {};
  for (const s of extractAst(rel, ext, src)?.symbols ?? []) out[s.parent ? `${s.parent}.${s.name}` : s.name] = s.signature;
  return out;
};

describe("a comment inside a declaration header", () => {
  it("leaves a Python def and class, including the body's first comment", () => {
    // 45 flask signatures carried one: `def test_register(client, app): # test
    // that viewing the page…` — the grammar hangs a body's leading comment on
    // the function, ahead of its block.
    const s = sigs(
      "m.py",
      [
        "def f(x): # noqa: E501",
        "    return x",
        "",
        "def g( # type: ignore[override]",
        "    a: int,",
        ") -> None:",
        "    # set up first",
        "    pass",
        "",
        "class K(Base): # pragma: no cover",
        "    pass",
      ].join("\n"),
    );
    expect(s).toMatchObject({ f: "def f(x):", g: "def g(a: int) -> None:", K: "class K(Base):" });
  });

  it("leaves Java, C, Go and Rust parameter lists without fusing or spacing the words around it", () => {
    expect(
      sigs(
        "A.java",
        "public class A {\n  public void run() // trailing\n  {\n  }\n  abstract void f(int a /* first */, int b);\n  void g(/* ctx */ int a) {}\n}",
      ),
    ).toMatchObject({ "A.run": "public void run()", "A.f": "abstract void f(int a, int b);", "A.g": "void g(int a)" });
    expect(sigs("h.c", "int add(int a, /* the a */ int/*b*/b) { return a + b; }")).toMatchObject({ add: "int add(int a, int b)" });
    expect(sigs("f.go", "package p\nfunc F(a int, // first\n\tb int) error {\n\treturn nil\n}")).toMatchObject({ F: "func F(a int, b int) error" });
    expect(sigs("m.rs", "pub fn add(a: i32, // a\n  b: i32) -> i32 { a + b }")).toMatchObject({ add: "pub fn add(a: i32, b: i32) -> i32" });
  });

  it("leaves a Ruby module, which used to show its first member's doc", () => {
    expect(sigs("w.rb", "module Acme\n  # A worker.\n  class Worker\n    def run(a) # trailing\n    end\n  end\nend")).toMatchObject({
      Acme: "module Acme",
      "Acme.Worker": "class Worker",
      "Worker.run": "def run(a)",
    });
  });

  it("leaves a constant's initializer, which keeps its value", () => {
    expect(sigs("c.ts", "export const obj = {\n  // why\n  a: 1,\n};\nexport const KEY = \"x\"; // trailing")).toMatchObject({
      obj: "obj = { a: 1 }",
      KEY: 'KEY = "x"',
    });
  });
});

describe("a body with no node of its own", () => {
  it("is cut from a Go interface that declares methods, and kept for a constraint", () => {
    // 14 gin interfaces read "Binding interface { Name() string Bind(…) error }".
    const s = sigs(
      "i.go",
      [
        "package p",
        "type Reader interface {",
        "\tio.Reader",
        "\t// Read reads bytes.",
        "\tRead(p []byte) (int, error)",
        "}",
        "type Number interface { ~int | ~float64 }",
        "type Pair interface { Reader; Writer }",
      ].join("\n"),
    );
    expect(s).toMatchObject({
      Reader: "Reader interface",
      "Reader.Read": "Read(p []byte) (int, error)",
      Number: "Number interface { ~int | ~float64 }",
      Pair: "Pair interface { Reader; Writer }",
    });
  });

  it("is cut from a Rust macro_rules and a C function-like macro; an object-like macro keeps its value", () => {
    expect(sigs("m.rs", "macro_rules! square {\n    ($x:expr) => { $x * $x };\n}\nmacro_rules! nop ( () => {} );")).toMatchObject({
      square: "macro_rules! square",
      nop: "macro_rules! nop",
    });
    expect(sigs("h.c", "#define SQ(x) \\\n  ((x) * (x))\n#define LIMIT \\\n  64\n")).toMatchObject({
      SQ: "#define SQ(x)",
      LIMIT: "#define LIMIT 64",
    });
  });

  it("drops the `end` of an empty Ruby body", () => {
    expect(sigs("e.rb", "class MyError < StandardError; end\nmodule Empty; end")).toMatchObject({
      MyError: "class MyError < StandardError",
      Empty: "module Empty",
    });
  });
});

describe("a function value bound to a name", () => {
  it("is cut at an expression body, as it always was at a block", () => {
    const s = sigs(
      "c.tsx",
      [
        "export const Card = ({ title }) => (",
        '  <div className="card">',
        "    <h1>{title}</h1>",
        "  </div>",
        ");",
        "export const add = (a: number, b: number): number => a + b;",
        "export const blk = async (x: string) => { return x; };",
        'export const toHref = id => "/a/" + id;',
      ].join("\n"),
    );
    // `toHref = id` is also what literals.ts reads as function-valued.
    expect(s).toMatchObject({
      Card: "Card = ({ title })",
      add: "add = (a: number, b: number): number",
      blk: "blk = async (x: string)",
      toHref: "toHref = id",
    });
  });

  it("is cut in Lua, Java and Python too", () => {
    expect(sigs("a.lua", "local M = {}\nM.f = function(a) -- note\n  return a + 1\nend\nreturn M")).toMatchObject({ "M.f": "M.f = function(a)" });
    expect(sigs("J.java", "class J {\n  Runnable r = () -> {\n    go();\n  };\n}")).toMatchObject({ "J.r": "Runnable r = () ->" });
    expect(sigs("p.py", "inc = lambda x: x + 1")).toMatchObject({ inc: "inc = lambda x:" });
  });

  it("is left whole when the function is only an operand, not the value", () => {
    expect(sigs("t.ts", "export const pick = cond ? () => 1 : () => 2;")).toMatchObject({ pick: "pick = cond ? () => 1 : () => 2" });
  });
});

describe("a list the formatter wrapped", () => {
  it("reads as one line with no padding inside the brackets and no trailing comma", () => {
    const s = sigs(
      "s.ts",
      [
        "export class Service<T> {",
        "  static create<U>(",
        "    a: U,",
        "    b: string,",
        "  ): Service<U & object> { return null as any; }",
        "}",
        "export function Card({",
        "  title,",
        "  body,",
        "}: Props) {}",
      ].join("\n"),
    );
    expect(s).toMatchObject({
      "Service.create": "static create<U>(a: U, b: string): Service<U & object>",
      Card: "function Card({ title, body }: Props)",
    });
  });

  it("leaves an author's own spacing inside brackets alone", () => {
    expect(sigs("h.c", "int add( int a, int b ) { return a + b; }")).toMatchObject({ add: "int add( int a, int b )" });
  });
});
