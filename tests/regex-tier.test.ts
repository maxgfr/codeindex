import { describe, expect, it } from "vitest";
import { extractSymbols } from "../src/lang/registry.js";

// The regex tier is the ONLY tier for Swift and Dart (no loadable grammar), and
// for Kotlin and Elixir until `grammars pull`. What it reports there is what
// find_symbol, deadcode, search and the repo map report.

const syms = (rel: string, src: string) => extractSymbols(rel, rel.slice(rel.lastIndexOf(".")), src);
const table = (rel: string, src: string) => syms(rel, src).map((s) => `${s.line} ${s.kind} ${s.name}`);

describe("Dart: declarations, not call sites", () => {
  // The audit's probe: every line of this body used to be an exported function
  // (`if`, `print`, `while`, `switch`, `for`, `setState`, `debugPrint`, `Text`).
  const widget = [
    "class W extends StatelessWidget {",
    "  @override",
    "  Widget build(BuildContext context) {",
    "    if (loading) {",
    "      print('x');",
    "    }",
    "    while (running) {",
    "    }",
    "    switch (mode) {",
    "    }",
    "    for (final x in xs) {",
    "    }",
    "    setState(() {",
    "    });",
    "    debugPrint(message);",
    "    await Future.wait([]);",
    "    do step(); while (again);",
    "    return const Text('hello');",
    "  }",
    "}",
  ].join("\n");

  it("indexes the class and its method and nothing in the body", () => {
    expect(table("w.dart", widget)).toEqual(["1 class W", "3 function build"]);
  });

  it("keeps every declaration shape a function can take", () => {
    const src = [
      "const kPadding = 8.0;", // 1
      "final _cache = <String, int>{};",
      "main() => runApp(const App());", // column 0: type-less is a declaration
      "Future<List<int>> fetch(", // a wrapped parameter list
      "  String url, {",
      "  int retries = 3,",
      "}) async {",
      "  void inner() {}", // a local function is still a declaration
      "  return [];",
      "}", // 10
      "class Box<T> {",
      "  Stream<int> count() async* {}",
      "  int get length => 0;",
      "  Iterable<int> get items sync* {}",
      "  set length(int v) {}",
      "  Future<Response> get(Uri url) async => throw 1;", // a method named `get`
      "  void on(void Function() cb) {}",
      "  T? firstOrNull<T>(Iterable<T> it) => null;",
      "  static Map<String, List<int>> index(String s) => {};",
      "}",
    ].join("\n");
    expect(table("a.dart", src)).toEqual([
      "1 const kPadding",
      "2 const _cache",
      "3 function main",
      "4 function fetch",
      "8 function inner",
      "11 class Box",
      "12 function count",
      "13 getter length",
      "14 getter items",
      "15 setter length",
      "16 function get",
      "17 function on",
      "18 function firstOrNull",
      "19 function index",
    ]);
    expect(syms("a.dart", src).find((s) => s.name === "_cache")?.exported).toBe(false);
  });

  it("finds constructors of the enclosing type only, at member depth", () => {
    const src = [
      "class App {", // 1
      "  const App({super.key});",
      "  factory App.fromJson(Map<String, dynamic> json) => App();",
      "  App._internal();",
      "  void run() {",
      "    App.helper(1);", // a static call in a body, not a constructor
      "    Other(2);",
      "  }",
      "}",
      "enum Color {", // 10
      "  red(1), green(2);",
      "  const Color(this.value);",
      "  final int value;",
      "}",
      "extension type const Id(int value) {", // 15
      "  Id.parse(String s) : this(int.parse(s));",
      "}",
      "void main() {",
      "  App();", // the class body closed at column 0: a statement
      "}",
    ].join("\n");
    expect(table("c.dart", src)).toEqual([
      "1 class App",
      "2 constructor App",
      "3 constructor fromJson",
      "4 constructor _internal",
      "5 function run",
      "10 enum Color",
      "12 constructor Color",
      "15 extension Id",
      "16 constructor parse",
      "18 function main",
    ]);
    expect(syms("c.dart", src).find((s) => s.name === "_internal")?.exported).toBe(false);
  });

  it("tells a top-level constant from a variable, and ignores locals", () => {
    const src = ["late final List<String> args;", "var counter = 0;", "final Context posix = Context();", "void f() {", "  final local = 1;", "}"].join("\n");
    expect(table("v.dart", src)).toEqual(["1 var args", "2 var counter", "3 const posix", "4 function f"]);
  });

  it("names type modifiers and extensions correctly", () => {
    const src = ["mixin class Both {}", "base mixin Tracks {}", "extension on String {}", "extension StringX on String {}"].join("\n");
    expect(table("m.dart", src)).toEqual(["1 class Both", "2 mixin Tracks", "4 extension StringX"]);
  });
});

// With `endLine` as well: `line-endLine kind name`, endLine blank when absent.
const spans = (rel: string, src: string) =>
  syms(rel, src).map((s) => `${s.line}-${s.endLine ?? ""} ${s.kind} ${s.name}`);

describe("Kotlin: the declarations a regex tier used to miss", () => {
  it("reads extension and generic functions, class kinds, aliases and properties", () => {
    const src = [
      "fun String.shout(): String = uppercase()", // 1
      "suspend fun <T> List<T>.firstOrNone(): T? = firstOrNull()",
      "fun <K, V> Map<K, V>?.orEmpty(): Map<K, V> = this ?: emptyMap()",
      "enum class Color { RED, GREEN }",
      "value class Id(val v: Int)",
      "annotation class Marker",
      "sealed interface Shape",
      "fun interface Handler { fun handle() }",
      "typealias Names = List<String>",
      "const val MAX = 10", // 10
      "private val cache by lazy { mutableMapOf<String, Int>() }",
      "internal fun make(): Int = 1",
      "data class P(val x: Int) {",
      "    val area: Int get() = x * x",
      "    fun scale(k: Int): P {",
      "        val local = k * x",
      "        return P(local)",
      "    }",
      "}",
    ].join("\n");
    expect(spans("a.kt", src)).toEqual([
      "1- function shout",
      "2- function firstOrNone",
      "3- function orEmpty",
      "4-4 enum Color",
      "5- class Id",
      "6- annotation Marker",
      "7- interface Shape",
      "8-8 interface Handler",
      "9- type Names",
      "10- property MAX",
      "11-11 property cache",
      "12- function make",
      "13-19 class P",
      "14- property area",
      "15-18 function scale",
    ]);
    const by = Object.fromEntries(syms("a.kt", src).map((s) => [s.name, s.exported]));
    // `internal` is visible to the whole module, as the AST tier reads it.
    expect(by.make).toBe(true);
    expect(by.cache).toBe(false);
  });
});

describe("Swift: attributes, modifiers in any order, members", () => {
  const src = [
    "/// A worker that runs jobs.", // 1
    "public final class Worker {",
    "    /// The queue name.",
    "    public private(set) var name: String",
    "    let id = 0",
    "",
    "    @objc public func run() {",
    "        let local = 1",
    "        print(local)",
    "    }", // 10
    "",
    "    init(name: String) {",
    "        self.name = name",
    "    }",
    "",
    "    convenience init?() { self.init(name: \"}\") }",
    "    deinit {}",
    "    subscript(i: Int) -> Int { i }",
    "    class func make() -> Worker { Worker(name: \"x\") }",
    "}", // 20
    "public actor Counter {}",
    "indirect enum Tree { case leaf }",
    "extension Worker: CustomStringConvertible {",
    "    public var description: String { name }",
    "}",
    "public typealias Handler = () -> Void",
    "@MainActor public protocol Viewer {}",
    "fileprivate struct Hidden {}",
    "let raw = #\"a \" { quote\"#",
  ].join("\n");

  it("indexes every declaration, not the locals in a body", () => {
    expect(spans("w.swift", src)).toEqual([
      "2-20 class Worker",
      "4- property name",
      "5- property id",
      "7-10 function run",
      "12-14 constructor init",
      "16-16 constructor init",
      "17-17 destructor deinit",
      "18-18 method subscript",
      "19-19 function make",
      "21-21 actor Counter",
      "22-22 enum Tree",
      "23-25 extension Worker",
      "24-24 property description",
      "26- type Handler",
      "27-27 protocol Viewer",
      "28-28 struct Hidden",
      "29- property raw",
    ]);
  });

  it("reads doc comments and visibility", () => {
    const by = Object.fromEntries(syms("w.swift", src).map((s) => [`${s.kind} ${s.name}`, s]));
    expect(by["class Worker"]!.doc).toBe("A worker that runs jobs.");
    expect(by["property name"]!.doc).toBe("The queue name.");
    // `private(set)` restricts the setter only; the property stays public.
    expect(by["property name"]!.exported).toBe(true);
    expect(by["struct Hidden"]!.exported).toBe(false);
  });
});

describe("Go: generics and package-level constants", () => {
  it("reads type parameters, grouped and single const/var/type specs", () => {
    const src = [
      "package demo", // 1
      "",
      "// Box holds a value.",
      "type Box[T any] struct {",
      "\tv T",
      "}",
      "",
      "func Map[T, U any](xs []T, f func(T) U) []U {",
      "\treturn nil",
      "}", // 10
      "",
      "func (b *Box[T]) Ready() <-chan struct{} {",
      "\treturn nil",
      "}",
      "",
      "type Bytes [4]byte",
      "const Max = 10",
      "var _ Iface = (*Box[int])(nil)",
      "",
      "const (", // 20
      "\tA Kind = iota",
      "\tB",
      "\t_",
      ")",
      "",
      "var (",
      "\tDefault = Box[int]{}",
      "\tlookup  = map[string]int{",
      "\t\t\"a\": 1,",
      "\t}", // 30
      ")",
      "",
      "type (",
      "\tÉtat int",
      "\tReader interface{ Read() }",
      ")",
    ].join("\n");
    expect(spans("a.go", src)).toEqual([
      "4-6 struct Box",
      "8-10 function Map",
      "12-14 method Ready",
      "16- type Bytes",
      "17- const Max",
      "21- const A",
      "22- const B",
      "27-27 var Default",
      "28-30 var lookup",
      "34- type État",
      "35-35 interface Reader",
    ]);
    const by = Object.fromEntries(syms("a.go", src).map((s) => [s.name, s]));
    expect(by.Box!.doc).toBe("Box holds a value.");
    expect(by.État!.exported).toBe(true); // an uppercase letter in any script
    expect(by.lookup!.exported).toBe(false);
  });
});

describe("TS/JS fallback: generators, ambient declarations, Unicode names", () => {
  it("indexes what a .d.ts declares and skips what a template literal says", () => {
    const src = [
      "export function* genFn() {}", // 1
      "export declare function declared(x: number): void;",
      "export declare abstract class DeclaredClass {}",
      "export declare const declaredConst: number;",
      "declare function ambient(): void;",
      "export namespace NS { export const a = 1; }",
      "export function café() {}",
      "export const Ünïcode = 1;",
      "export class 日本語 {}",
      "const tpl = `", // 10
      "export function notARealFunction() {}",
      "`;",
      "/*",
      "function ghost() {}",
      "*/",
      "const functionality = 3;",
      "declare class Emitter {}",
      "export = Emitter;",
    ].join("\n");
    expect(table("d.ts", src)).toEqual([
      "1 function genFn",
      "2 function declared",
      "3 class DeclaredClass",
      "4 const declaredConst",
      "5 function ambient",
      "6 namespace NS",
      "7 function café",
      "8 const Ünïcode",
      "9 class 日本語",
      "10 const tpl",
      "16 const functionality",
      "17 class Emitter",
    ]);
    // `export = Emitter` is how a declaration file exports its one value.
    expect(syms("d.ts", src).find((s) => s.name === "Emitter")?.exported).toBe(true);
  });
});

describe("doc comments and body spans on the regex tier", () => {
  it("takes the comment run above a declaration, past annotations, not across a blank line", () => {
    const src = [
      "/**", // 1
      " * Parses the input.",
      " * @param s the text",
      " */",
      "@Deprecated",
      "public int parse(String s) {",
      "  return 0;",
      "}",
      "// a note about the section",
      "", // 10
      "public void undocumented() {}",
      "int x = 1; /* trailing */",
      "public void afterTrailing() {}",
      "public abstract void pending();",
    ].join("\n");
    const by = Object.fromEntries(syms("A.java", src).map((s) => [s.name, s]));
    expect(by.parse!.doc).toBe("Parses the input.");
    expect(by.parse!.endLine).toBe(8);
    expect(by.undocumented!.doc).toBeUndefined();
    expect(by.afterTrailing!.doc).toBeUndefined();
    expect(by.undocumented!.endLine).toBe(11);
    // An abstract method has no body; a guessed span would be wrong.
    expect(by.pending!.endLine).toBeUndefined();
  });

  it("gives no span when the braces do not close where a formatter would put them", () => {
    const src = [
      "export type Pair = {", // 1
      "  a: number;",
      "} | {",
      "  b: string;",
      "};",
      "export type Cond = T extends { x: 1 } ? {}",
      "  : never;",
      "export const table = {",
      "  a: 1,",
      "    };", // 10: the close is not at the declaration's indentation
      "export function f<T = {}>(): T {",
      "  return {} as T;",
      "}",
    ].join("\n");
    expect(spans("t.ts", src)).toEqual(["1- type Pair", "6- type Cond", "8- const table", "11-13 function f"]);
  });

  it("does not let a Rust raw or multi-line string, or a lifetime, unbalance the braces", () => {
    const src = [
      "/// Renders the thing.", // 1
      "pub fn render<'a>(x: &'a str) -> String {",
      "    let s = r#\"a \" } { \"#;",
      "    let t = \"line one {",
      "line two\";",
      "    format!(\"{}{}\", s, t)",
      "}",
      "fn next() {}",
    ].join("\n");
    expect(spans("a.rs", src)).toEqual(["2-7 function render", "8-8 function next"]);
    expect(syms("a.rs", src)[0]!.doc).toBe("Renders the thing.");
  });

  it("reads an Elixir @doc and a Ruby comment", () => {
    const ex = [
      "defmodule M do",
      '  @doc """',
      "  Adds two numbers.",
      "",
      "  More detail.",
      '  """',
      "  @spec add(integer, integer) :: integer",
      "  def add(a, b), do: a + b",
      "",
      '  @doc "Subtracts."',
      "  def sub(a, b), do: a - b",
      "end",
    ].join("\n");
    const by = Object.fromEntries(syms("m.ex", ex).map((s) => [s.name, s.doc]));
    expect(by.add).toBe("Adds two numbers.");
    expect(by.sub).toBe("Subtracts.");
    const rb = ["# Greets the caller.", "def greet(name)", "  \"hi #{name}\"", "end"].join("\n");
    expect(syms("g.rb", rb)[0]!.doc).toBe("Greets the caller.");
  });
});
