import { describe, expect, it } from "vitest";
import { braceBodyEnd, leadingBlockStart } from "../src/edit-spans.js";

// 1-based end line of the declaration on 1-based `line`, or undefined.
const end = (src: string, line: number, lang: string): number | undefined => {
  const found = braceBodyEnd(src.split("\n"), line - 1, lang);
  return found === undefined ? undefined : found + 1;
};

describe("braceBodyEnd (regex-tier declaration spans)", () => {
  it("matches a Swift function's own closing brace", () => {
    const src = "func area(w: Double) -> Double {\n    let x = w\n    return x\n}\n\nfunc next() {\n}\n";
    expect(end(src, 1, "swift")).toBe(4);
  });

  it("closes a one-line body on its own line", () => {
    expect(end("func f() { return 1 }\nfunc g() {}\n", 1, "swift")).toBe(1);
  });

  it("follows a parameter list split over lines", () => {
    const src = "fun f(\n    a: Int,\n    b: Int,\n): Int {\n    return a + b\n}\n";
    expect(end(src, 1, "kotlin")).toBe(6);
  });

  it("ignores braces inside strings, interpolations and nested comments", () => {
    const swift = [
      "func f() -> String {",
      '    let a = "}"',
      '    let b = "\\(g("}"))"',
      '    let c = #"raw } "quoted" \\(x)"#',
      "    /* outer /* nested } */ still comment } */",
      '    let d = """',
      "    }",
      '    """',
      "    return a // }",
      "}",
    ].join("\n");
    expect(end(swift, 1, "swift")).toBe(10);
    const kotlin = ['fun f(): String {', '    val a = "${mapOf("k" to "}")["k"]}"', "    val c = '}'", '    val t = """ } ${ "{" } """', "    return a", "}"].join("\n");
    expect(end(kotlin, 1, "kotlin")).toBe(6);
    const dart = ["String f() {", "  final a = '}';", "  final b = r'\\}';", '  final c = "${"}"}";', "  final d = '''", "  }", "  ''';", "  return a;", "}"].join("\n");
    expect(end(dart, 1, "dart")).toBe(9);
  });

  it("ends a body-less declaration at its semicolon", () => {
    expect(end("int add(int a, int b) => a + b;\n\nint sub() {\n}\n", 1, "dart")).toBe(1);
    expect(end("int add(int a, int b) =>\n    a + b;\nint sub() {\n}\n", 1, "dart")).toBe(2);
    expect(end("bool isAlpha(int c) =>\n    (c >= 65 && c <= 90) ||\n    (c >= 97 && c <= 122);\n", 1, "dart")).toBe(3);
  });

  it("refuses rather than borrowing a sibling's braces", () => {
    // A protocol requirement has no body: the next declaration's braces are not its own.
    expect(end("protocol P {\n    func a() -> Int\n    func b() {\n    }\n}\n", 2, "swift")).toBeUndefined();
    // Kotlin expression body continued on the next line, never closed by a brace.
    expect(end("fun f() =\n    42\nfun g() {\n}\n", 1, "kotlin")).toBeUndefined();
    // Unbalanced text (an unterminated string) is not guessed through.
    expect(end('func f() {\n    let s = "abc\n}\n', 1, "swift")).toBeUndefined();
    // A closing brace that does not line up with the header.
    expect(end("func f() {\n    return 1\n    }\nfunc g() {}\n", 1, "swift")).toBeUndefined();
    // Code after the closing brace on the same line.
    expect(end("func f() {\n    return 1\n} + 2\n", 1, "swift")).toBeUndefined();
    // Never guessed for languages whose bodies are not braces (Elixir) or that always have an AST span.
    expect(end("def f(x) do\n  x\nend\n", 1, "elixir")).toBeUndefined();
    expect(end("function f() {\n}\n", 1, "typescript")).toBeUndefined();
  });

  it("accepts an Allman brace and an indented continuation", () => {
    expect(end("func f()\n{\n    return\n}\n", 1, "swift")).toBe(4);
    expect(end("class Foo(val x: Int) :\n    Base(),\n    Iface {\n    val y = 1\n}\n", 1, "kotlin")).toBe(5);
  });
});

// 1-based first line of the leading block above the declaration on 1-based `line`.
const lead = (src: string, line: number, lang: string): number => leadingBlockStart(src.split("\n"), line - 1, lang) + 1;

describe("leadingBlockStart (decorators and doc comments above a declaration)", () => {
  it("climbs over Python decorators and comments, stopping at code", () => {
    const src = "class S:\n    # comment\n    @setupmethod\n    @other(\n        1,\n    )\n    def route(self):\n        pass\n";
    expect(lead(src, 7, "python")).toBe(2);
    // A call ending in `)` above a def is a statement, not a decorator.
    expect(lead("x = foo(\n    1)\ndef f():\n    pass\n", 3, "python")).toBe(3);
  });

  it("keeps a godoc comment with its function but not a separated header", () => {
    const src = "// Package header.\n\n// Run attaches.\n// It blocks.\nfunc Run() {}\n";
    expect(lead(src, 5, "go")).toBe(3);
  });

  it("climbs over TypeScript multi-line decorators and JSDoc", () => {
    const src = "/**\n * Widget.\n */\n@Component({\n  selector: 'x(',\n})\nexport class Widget {\n  // handler\n  @HostListener('click')\n  onClick() {}\n}\n";
    expect(lead(src, 7, "typescript")).toBe(1);
    expect(lead(src, 10, "typescript")).toBe(8);
  });

  it("knows Rust, C# and C++ attribute forms", () => {
    expect(lead("/// Doc.\n#[derive(\n    Debug,\n)]\n#[inline]\npub fn f() {}\n", 6, "rust")).toBe(1);
    expect(lead("/// <summary>x</summary>\n[Serializable]\npublic class C {}\n", 3, "csharp")).toBe(1);
    expect(lead("// Twice.\ntemplate <typename T,\n          typename U>\nT twice(T x) { return x; }\n", 4, "cpp")).toBe(1);
  });

  it("does not absorb a trailing comment of code, a shebang, or a C preprocessor line", () => {
    expect(lead("int x = 1; /* note\n   more */\nvoid f() {}\n", 3, "c")).toBe(3);
    expect(lead("#!/bin/sh\n# doc\nf() {\n}\n", 3, "shell")).toBe(2);
    expect(lead("#ifdef X\nvoid f() {}\n", 2, "c")).toBe(2);
  });
});
