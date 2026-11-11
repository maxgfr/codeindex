import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo, type RepoScan } from "../src/scan.js";
import { buildCallerIndex } from "../src/callers.js";
import { resolveCallEdges } from "../src/calls.js";
import { buildSymbolGraph } from "../src/symbolgraph.js";
import { buildTypeHierarchy, implementationsOf } from "../src/relations.js";
import { importPairsFor } from "../src/derived.js";
import { collectCallsRegex, extractCode } from "../src/extract/code.js";
import { UNNAMED_RECEIVER } from "../src/types.js";
import { buildArtifactsFromScan } from "../src/pipeline.js";

// The shared call-site binder (src/bind.ts) on a real extraction: every case
// here bound to the WRONG declaration, or to none, when binding looked at the
// callee name alone. One repo per language family keeps each rule visible.

const FILES: Record<string, string> = {
  // --- Go: package `app` at the root, `use` importing it, `sub` not ----------
  "go.mod": "module example.com/app\n\ngo 1.21\n",
  "gin.go": [
    "package app",
    "",
    'import "errors"',
    "",
    "type Engine struct{}",
    "",
    "func New() *Engine { return &Engine{} }",
    "",
    "func (e *Engine) Run() error { return nil }",
    "",
    "func (e *Engine) Start() error {",
    '\tdebugPrint("start")',
    "\treturn e.Run()",
    "}",
    "",
    'func fail() error { return errors.New("x") }',
    "",
  ].join("\n"),
  "debug.go": 'package app\n\nimport "fmt"\n\nfunc debugPrint(format string) { fmt.Println(format) }\n',
  "context.go": 'package app\n\ntype Context struct{}\n\nfunc (c *Context) ClientIP() string { return "" }\n\ntype ResponseWriter interface{ Header() }\n',
  "logger.go": [
    "package app",
    "",
    "type LogParams struct {",
    "\tClientIP string",
    "}",
    "",
    "func logWith(c *Context) LogParams {",
    "\tp := LogParams{}",
    "\tp.ClientIP = c.ClientIP()",
    "\treturn p",
    "}",
    "",
  ].join("\n"),
  "reset.go": "package app\n\nfunc resetAll(x interface{ Reset() }) { x.Reset() }\n",
  // Sorts first in the directory, yet the package's import resolves to its
  // first non-test file (context.go) — a non-test importer must never see it.
  "app_test.go": [
    "package app",
    "",
    'import "testing"',
    "",
    "type fakeBuffer struct{}",
    "",
    "func (fakeBuffer) Reset() {}",
    "",
    "func TestRun(t *testing.T) {",
    '\tt.Run("x", func(t *testing.T) {})',
    "\tfail()",
    "}",
    "",
  ].join("\n"),
  "use/use.go": [
    "package use",
    "",
    'import "example.com/app"',
    "",
    "func Boot() error {",
    "\te := app.New()",
    "\treturn e.Run()",
    "}",
    "",
    "var _ app.ResponseWriter",
    "",
    "var _ app.LogParams",
    "",
  ].join("\n"),
  // Names gin's unique `ResponseWriter` — as net/http's, since it imports no
  // package of the repo.
  "sub/sub.go": [
    "package sub",
    "",
    'import (\n\t"errors"\n\t"net/http"\n)',
    "",
    'func Make() error { return errors.New("x") }',
    "",
    "func Call(e interface{ Run() error }) error { return e.Run() }",
    "",
    "func Write(w http.ResponseWriter) {}",
    "",
  ].join("\n"),

  // --- Python: a package with a re-exporting __init__, an example app -------
  "pkg/__init__.py": "from .helpers import url_for as url_for\nfrom .app import App\n",
  "pkg/helpers.py": [
    "def url_for(endpoint):",
    "    return endpoint",
    "",
    "",
    "def update_all(kwargs):",
    "    kwargs.update(x=1)",
    "    return kwargs",
    "",
  ].join("\n"),
  "pkg/app.py": [
    "class App:",
    "    def ensure_sync(self, f):",
    "        return f",
    "",
    "    def run(self, g):",
    "        return self.ensure_sync(g)()",
    "",
  ].join("\n"),
  "pkg/sansio/base.py": "class Base:\n    def _private(self):\n        return 1\n",
  "pkg/blueprints.py": [
    "from .sansio.base import Base as SansioBase",
    "",
    "",
    "class Blueprint(SansioBase):",
    "    def go(self):",
    "        return self._private()",
    "",
  ].join("\n"),
  "examples/blog.py": "def update():\n    return 1\n",
  "tests/test_app.py": 'import pkg\n\n\ndef test_url():\n    assert pkg.url_for("x") == "x"\n',

  // --- TypeScript: a barrel, renamed / default / namespace imports ----------
  "ts/lib/greet.ts": [
    "export function greet(name: string): string {",
    '  return "hi " + name;',
    "}",
    "export default function defaultGreet(): string {",
    '  return greet("default");',
    "}",
    "export class Greeter {",
    "  hello(): string {",
    '    return greet("x");',
    "  }",
    "  static make(): Greeter {",
    "    return new Greeter();",
    "  }",
    "}",
    "",
  ].join("\n"),
  "ts/lib/index.ts": 'export { greet, Greeter } from "./greet.js";\n',
  "ts/viabarrel.ts": [
    'import { greet, Greeter } from "./lib/index.js";',
    "export function viaBarrel(): string {",
    "  const g = new Greeter();",
    "  g.hello();",
    "  Greeter.make();",
    '  return greet("barrel");',
    "}",
    "",
  ].join("\n"),
  "ts/aliased.ts": [
    'import { greet as salute } from "./lib/greet.js";',
    'import dflt from "./lib/greet.js";',
    'import * as G from "./lib/greet.js";',
    "export function useAlias(): void {",
    '  salute("a");',
    "  dflt();",
    '  G.greet("ns");',
    "}",
    "",
  ].join("\n"),
  "ts/store.ts": [
    "export class Store {",
    "  private map = new Map<string, string>();",
    "  get(k: string): string | undefined {",
    "    return this.map.get(k);",
    "  }",
    "  set(k: string, v: string): void {",
    "    this.map.set(k, v);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "ts/useStore.ts": [
    'import { Store } from "./store.js";',
    "export function run(): string | undefined {",
    "  const s = new Store();",
    '  s.set("a", "b");',
    '  return s.get("a");',
    "}",
    "",
  ].join("\n"),
};

let repo: string;
let scan: RepoScan;
let pairs: Set<string>;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ci-call-binding-"));
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  scan = scanRepo(repo);
  pairs = importPairsFor(scan);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

// Every bound site as `file:line -> [Parent.]name@file:line`, sorted.
function bindings(opts: { recall?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const e of buildCallerIndex(scan, pairs, opts).values()) {
    for (const c of e.callers) out.push(`${c.file}:${c.line} -> ${e.def.parent ? e.def.parent + "." : ""}${e.def.name}@${e.def.file}:${e.def.line}`);
  }
  return out.sort();
}
const sitesIn = (all: string[], file: string): string[] => all.filter((b) => b.startsWith(file + ":"));

describe("import aliases (extraction)", () => {
  it("records renamed, default and namespace imports, and the module's own default export", () => {
    const rec = scan.files.find((f) => f.rel === "ts/aliased.ts")!;
    expect(rec.importAliases).toEqual([
      { local: "G", name: "*", from: "./lib/greet.js" },
      { local: "dflt", name: "default", from: "./lib/greet.js" },
      { local: "salute", name: "greet", from: "./lib/greet.js" },
    ]);
    expect(scan.files.find((f) => f.rel === "ts/lib/greet.ts")!.importAliases).toEqual([{ local: "default", name: "defaultGreet" }]);
  });

  it("records Python module imports and `from m import a as b`, but not the `a as a` re-export marker", () => {
    expect(scan.files.find((f) => f.rel === "tests/test_app.py")!.importAliases).toEqual([{ local: "pkg", name: "*", from: "pkg" }]);
    expect(scan.files.find((f) => f.rel === "pkg/blueprints.py")!.importAliases).toEqual([
      { local: "SansioBase", name: "Base", from: ".sansio.base" },
    ]);
    expect(scan.files.find((f) => f.rel === "pkg/__init__.py")!.importAliases).toBeUndefined();
  });

  it("records an explicit Go package name only", () => {
    const { importAliases } = extractCode("x.go", ".go", 'package x\n\nimport (\n\tfoo "example.com/bar"\n\t"fmt"\n\t_ "embed"\n)\n', {});
    expect(importAliases).toEqual([{ local: "foo", name: "*", from: "example.com/bar" }]);
  });

  it("gives a curried call the receiver of its inner callee", () => {
    const rec = scan.files.find((f) => f.rel === "pkg/app.py")!;
    expect(rec.calls).toContainEqual({ name: "ensure_sync", line: 6, receiver: "self" });
  });
});

describe("the call-site binder", () => {
  it("Go: a package call binds only into the package it names, never into one outside the repo", () => {
    const all = bindings();
    // errors.New / fmt.Println are the standard library's, not app.New.
    expect(all.filter((b) => b.includes("-> New@"))).toEqual(["use/use.go:6 -> New@gin.go:7"]);
    expect(all.some((b) => b.includes("Println"))).toBe(false);
  });

  it("Go: an unexported function binds from every file of its package", () => {
    const all = bindings();
    expect(all).toContain("gin.go:12 -> debugPrint@debug.go:5");
    expect(all).toContain("app_test.go:11 -> fail@gin.go:16");
  });

  it("Go: a method binds through the receiver's type, not a same-file field of that name", () => {
    const all = bindings();
    expect(sitesIn(all, "logger.go")).toEqual(["logger.go:9 -> Context.ClientIP@context.go:5"]);
    expect(all).toContain("gin.go:13 -> Engine.Run@gin.go:9");
    // Another package reaches a method only through a package it imports.
    expect(all).toContain("use/use.go:7 -> Engine.Run@gin.go:9");
    expect(sitesIn(all, "sub/sub.go")).toEqual([]);
  });

  it("Go: a _test.go file is invisible to the rest of its package, and a stdlib-typed receiver binds nothing", () => {
    const all = bindings();
    expect(sitesIn(all, "reset.go")).toEqual([]); // not fakeBuffer.Reset
    expect(all.some((b) => b.startsWith("app_test.go:10 "))).toBe(false); // t.Run on *testing.T is not Engine.Run
  });

  it("Python: a call on a variable never binds to a free function, a tail file never serves the product", () => {
    expect(sitesIn(bindings(), "pkg/helpers.py")).toEqual([]); // kwargs.update is not examples/blog.py's view
  });

  it("Python: self-calls reach the enclosing class and an imported base, through a curried call and a rename", () => {
    const all = bindings();
    expect(all).toContain("pkg/app.py:6 -> App.ensure_sync@pkg/app.py:2");
    expect(all).toContain("pkg/blueprints.py:6 -> Base._private@pkg/sansio/base.py:2");
  });

  it("Python: a module attribute binds through the package's __init__ re-exports", () => {
    expect(sitesIn(bindings(), "tests/test_app.py")).toEqual(["tests/test_app.py:5 -> url_for@pkg/helpers.py:1"]);
  });

  it("TS: calls through a barrel, a renamed, a default and a namespace import all bind", () => {
    const all = bindings();
    expect(sitesIn(all, "ts/viabarrel.ts")).toEqual([
      "ts/viabarrel.ts:3 -> Greeter@ts/lib/greet.ts:7",
      "ts/viabarrel.ts:4 -> Greeter.hello@ts/lib/greet.ts:8",
      "ts/viabarrel.ts:5 -> Greeter.make@ts/lib/greet.ts:11",
      "ts/viabarrel.ts:6 -> greet@ts/lib/greet.ts:1",
    ]);
    expect(sitesIn(all, "ts/aliased.ts")).toEqual([
      "ts/aliased.ts:5 -> greet@ts/lib/greet.ts:1",
      "ts/aliased.ts:6 -> defaultGreet@ts/lib/greet.ts:4",
      "ts/aliased.ts:7 -> greet@ts/lib/greet.ts:1",
    ]);
  });

  it("TS: a call on some other object is not a call to the enclosing class's homonym", () => {
    const all = bindings();
    expect(sitesIn(all, "ts/store.ts")).toEqual([]); // this.map.get is Map#get, not Store.get
    expect(sitesIn(all, "ts/useStore.ts")).toEqual([
      "ts/useStore.ts:3 -> Store@ts/store.ts:1",
      "ts/useStore.ts:4 -> Store.set@ts/store.ts:6",
      "ts/useStore.ts:5 -> Store.get@ts/store.ts:3",
    ]);
  });

  it("recall mode keeps the name-driven shadowing, labelled", () => {
    const recall = buildCallerIndex(scan, pairs, { recall: true });
    expect(recall.get("get")?.callers).toContainEqual({ file: "ts/store.ts", line: 4, confidence: "corroborated" });
  });

  it("graph call edges, the caller index and the symbol graph agree", () => {
    const edges = resolveCallEdges(scan, pairs).map((e) => `${e.from}->${e.to} ${e.confidence}`);
    // No inference crosses a Go package boundary, or from the product into examples.
    expect(edges.filter((e) => e.startsWith("sub/"))).toEqual([]);
    expect(edges.some((e) => e.includes("examples/"))).toBe(false);
    expect(edges).toContain("use/use.go->gin.go extracted");
    expect(edges).toContain("ts/aliased.ts->ts/lib/greet.ts extracted");
    expect(edges).toContain("ts/viabarrel.ts->ts/lib/greet.ts extracted");
    expect(edges.filter((e) => e.endsWith(" inferred"))).toEqual([]);

    const graph = buildSymbolGraph(scan, pairs);
    const calls = graph.edges.filter((e) => e.kind === "calls").map((e) => `${e.from} -> ${e.to}`);
    expect(calls).toContain("logger.go#logWith -> context.go#Context/ClientIP");
    expect(calls).toContain("ts/aliased.ts#useAlias -> ts/lib/greet.ts#defaultGreet");
    expect(calls.some((c) => c.startsWith("ts/store.ts#Store/get -> ts/store.ts#Store/get"))).toBe(false);
  });
});

describe("Go use edges", () => {
  it("never link a Go file to a package it does not import", () => {
    const edges = buildArtifactsFromScan(scan).graph.fileEdges;
    const uses = edges.filter((e) => e.kind === "use").map((e) => `${e.from}->${e.to}`);
    // The package import resolves to its first non-test file, context.go, so
    // that pair is already linked by the import (no `use` on top of it)...
    expect(edges.filter((e) => e.from === "use/use.go" && e.to === "context.go").map((e) => e.kind)).toEqual(["import"]);
    // ...and another file of the imported package is reached by a `use` edge.
    expect(uses).toContain("use/use.go->logger.go");
    expect(uses.filter((u) => u.startsWith("sub/"))).toEqual([]);
  });
});

describe("relations through a renaming import", () => {
  it("resolves `class Blueprint(SansioBase)` to the base it renames", () => {
    const hierarchy = buildTypeHierarchy(scan, pairs);
    const entry = [...hierarchy.values()].find((e) => e.name === "Blueprint" && e.file === "pkg/blueprints.py");
    expect(entry?.extends.map((r) => `${r.name}@${r.file}`)).toEqual(["Base@pkg/sansio/base.py"]);
    expect(entry?.unresolved).toEqual([]);
    expect(implementationsOf(hierarchy, "Base").map((r) => `${r.name}@${r.file}`)).toEqual(["Blueprint@pkg/blueprints.py"]);
  });
});

// A member call is not a bare call. The AST tier used to drop a receiver whose
// name is not `[A-Za-z_]\w*`, so the call lost its receiver and bound, by name
// alone, to a same-file function it never calls.
describe("a receiver named with `$`, a private field or an instance variable", () => {
  const SOURCES: Record<string, string> = {
    "dollar.ts": [
      "export function render(): void {}",
      "export function drawDollar($el: { render(): void }): void {",
      "  $el.render();",
      "}",
      "export function drawPlain(el: { render(): void }): void {",
      "  el.render();",
      "}",
      "",
    ].join("\n"),
    "obs.js": ["export function subscribe() {}", "export function watch(clicks$) {", "  clicks$.subscribe();", "}", ""].join("\n"),
    "priv.ts": [
      "export function get(): number { return 1; }",
      "export class Store {",
      "  #cache = new Map<string, number>();",
      "  read(k: string): number | undefined {",
      "    return this.#cache.get(k);",
      "  }",
      "}",
      "",
    ].join("\n"),
    "ivar.rb": ["class Service", "  def save", "  end", "  def run", "    @repo.save", "  end", "end", ""].join("\n"),
  };
  let dir: string;
  let local: RepoScan;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ci-call-binding-sigil-"));
    for (const [rel, content] of Object.entries(SOURCES)) writeFileSync(join(dir, rel), content);
    local = scanRepo(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const callsIn = (rel: string) => local.files.find((f) => f.rel === rel)!.calls;

  it("keeps the receiver on the call site", () => {
    expect(callsIn("dollar.ts")).toEqual([
      { name: "render", line: 3, receiver: "$el" },
      { name: "render", line: 6, receiver: "el" },
    ]);
    expect(callsIn("obs.js")).toEqual([{ name: "subscribe", line: 3, receiver: "clicks$" }]);
    expect(callsIn("priv.ts")).toContainEqual({ name: "get", line: 5, receiver: "cache" });
    expect(callsIn("ivar.rb")).toEqual([{ name: "save", line: 5, receiver: "repo" }]);
  });

  it("binds none of them to the same-file function of that name", () => {
    const edges = buildSymbolGraph(local, importPairsFor(local))
      .edges.filter((e) => e.kind === "calls")
      .map((e) => `${e.from} -> ${e.to}`);
    expect(edges).toEqual([]);
  });
});

// A call made on something with no name at all — a literal, a subscript, a
// constructor's result — is still a member call. Recorded without a receiver it
// read as a bare call, and `'a,b'.split(',')` bound to a same-file `split`.
describe("a receiver that has no name", () => {
  const SOURCES: Record<string, string> = {
    "lit.ts": [
      "export function split(): void {}",
      "export function run(): void {}",
      "export function go(): void {}",
      "export function own(): void {}",
      "export class K {",
      "  own(): void {}",
      "  m(items: { run(): void }[]): void {",
      "    'a,b'.split(',');",
      "    items[0].run();",
      "    new K().go();",
      "    this.own();",
      "    split();",
      "  }",
      "}",
      "",
    ].join("\n"),
    "lit.py": ["def join():", "    pass", "", "def index():", "    pass", "", "def m(parts):", "    ', '.join(parts)", "    [1, 2].index(1)", "    join()", ""].join("\n"),
    "lit.go": ["package lit", "", "func Run() {}", "", "func M(items []T) {", "\titems[0].Run()", "\tRun()", "}", ""].join("\n"),
    "lit.rb": ["def split", "end", "", "def m(items)", "  'a,b'.split(',')", "  items[0].split", "end", ""].join("\n"),
    "Lit.java": ["class Lit {", "  void split() {}", "  void m() {", '    "a,b".split(",");', "    this.split();", "  }", "}", ""].join("\n"),
    "lit.rs": ["fn own() {}", "", "struct K;", "", "impl K {", "    fn own(&self) {}", "    fn m(&self) {", "        self.own();", "    }", "}", ""].join("\n"),
  };
  let dir: string;
  let local: RepoScan;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ci-call-binding-unnamed-"));
    for (const [rel, content] of Object.entries(SOURCES)) writeFileSync(join(dir, rel), content);
    local = scanRepo(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const callsIn = (rel: string) => local.files.find((f) => f.rel === rel)!.calls;

  it("is recorded as UNNAMED_RECEIVER; a call on this keeps `this`, a bare call keeps none", () => {
    expect(UNNAMED_RECEIVER).toBe("?");
    expect(callsIn("lit.ts")).toEqual([
      { name: "K", line: 10 },
      { name: "go", line: 10, receiver: "?" },
      { name: "own", line: 11, receiver: "this" },
      { name: "run", line: 9, receiver: "?" },
      { name: "split", line: 8, receiver: "?" },
      { name: "split", line: 12 },
    ]);
    expect(callsIn("lit.py")).toEqual([
      { name: "index", line: 9, receiver: "?" },
      { name: "join", line: 8, receiver: "?" },
      { name: "join", line: 10 },
    ]);
    expect(callsIn("lit.go")).toEqual([
      { name: "Run", line: 6, receiver: "?" },
      { name: "Run", line: 7 },
    ]);
    expect(callsIn("lit.rb")).toEqual([
      { name: "split", line: 5, receiver: "?" },
      { name: "split", line: 6, receiver: "?" },
    ]);
    expect(callsIn("lit.rs")).toEqual([{ name: "own", line: 8, receiver: "self" }]);
    expect(callsIn("Lit.java")).toEqual([
      { name: "split", line: 4, receiver: "?" },
      { name: "split", line: 5, receiver: "this" },
    ]);
  });

  it("binds only the calls that are really bare or on this, and `this.own()` to the method, not the function", () => {
    const edges = buildSymbolGraph(local, importPairsFor(local))
      .edges.filter((e) => e.kind === "calls")
      .map((e) => `${e.from} -> ${e.to}`)
      .sort();
    expect(edges).toEqual([
      "Lit.java#Lit/m -> Lit.java#Lit/split", // this.split()
      "lit.go#M -> lit.go#Run", // Run()
      "lit.py#m -> lit.py#join", // join()
      "lit.rs#K/m -> lit.rs#K/own", // self.own(), not the free fn own
      "lit.ts#K/m -> lit.ts#K", // new K()
      "lit.ts#K/m -> lit.ts#K/own", // this.own()
      "lit.ts#K/m -> lit.ts#split", // split()
    ]);
  });

  it("the regex tier reads the same sites the same way", () => {
    const sites = (code: string) => collectCallsRegex(code).map((c) => `${c.receiver ?? "-"}.${c.name}`);
    expect(sites("'a,b'.split(',');")).toEqual(["?.split"]);
    expect(sites("items[0].run();")).toEqual(["?.run"]);
    expect(sites("fetch(url)\n  .then(handle);")).toEqual(["-.fetch", "?.then"]);
    // The receiver of an optional or asserted access is named.
    expect(sites("a?.b?.opt(); obj!.bang();")).toEqual(["obj.bang", "b.opt"]);
    expect(sites("super().base()")).toEqual(["super.base", "-.super"]);
    // Not a member access: a range, a spread, PHP's spaced concatenation, a bare call.
    expect(sites("for i in 0..len(xs) {}")).toEqual(["-.len"]);
    expect(sites("call(...rest(xs));")).toEqual(["-.call", "-.rest"]);
    expect(sites("'x' . strlen($b);")).toEqual(["-.strlen"]);
    expect(sites("plain(1);")).toEqual(["-.plain"]);
  });
});

describe("one line calling a declaration under two names", () => {
  it("lists that line once among its callers", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-call-binding-alias-"));
    try {
      writeFileSync(join(dir, "m.ts"), "export function a(): number {\n  return 1;\n}\n");
      // `a` and its alias `b` on line 3, and `a` again on line 4: the sites sort
      // a@3, a@4, b@3, so the twin of a@3 is not the last caller pushed.
      writeFileSync(join(dir, "use.ts"), 'import { a, a as b } from "./m";\n\nexport const x = a() + b();\nexport const y = a();\n');
      const local = scanRepo(dir);
      const callers = buildCallerIndex(local, importPairsFor(local)).get("a")!.callers;
      expect(callers).toEqual([
        { file: "use.ts", line: 3 },
        { file: "use.ts", line: 4 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
