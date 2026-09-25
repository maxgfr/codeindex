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
