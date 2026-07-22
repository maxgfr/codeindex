import { describe, expect, it } from "vitest";
import { extractAst } from "../src/ast/extract.js";
import { extractCode } from "../src/extract/code.js";
import { jsTs } from "../src/lang/js-ts.js";

// EXTRACTOR_VERSION 6: call-site receivers (issue #7) and JS/TS export parity
// with ultradoc (issue #1), on BOTH the AST and the regex tier.

function exportedByKey(symbols: { kind: string; name: string; exported: boolean }[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const s of symbols) out[`${s.kind}:${s.name}`] ??= s.exported;
  return out;
}

describe("call-site receivers (AST tier)", () => {
  it("captures the immediate receiver of qualified JS/TS calls, none for bare calls", () => {
    const r = extractAst("a.ts", ".ts", 'axios.get("/x");\nget();\na.b.cee(1);\nnew vm.Script("s");\n')!;
    expect(r).toBeDefined();
    expect(r.calls).toContainEqual({ name: "get", line: 1, receiver: "axios" });
    expect(r.calls).toContainEqual({ name: "get", line: 2 }); // bare — no receiver key
    expect(r.calls).toContainEqual({ name: "cee", line: 3, receiver: "b" }); // immediate receiver only
    expect(r.calls).toContainEqual({ name: "Script", line: 4, receiver: "vm" }); // constructor
  });

  it("reads python attribute receivers", () => {
    const p = extractAst("m.py", ".py", "def go(client):\n    client.fetch(1)\n    fetch(2)\n")!;
    expect(p.calls).toContainEqual({ name: "fetch", line: 2, receiver: "client" });
    expect(p.calls).toContainEqual({ name: "fetch", line: 3 });
  });

  it("reads go selector receivers", () => {
    const g = extractAst("m.go", ".go", "package m\n\nfunc run() {\n\tfmt.Println(1)\n}\n")!;
    expect(g.calls).toContainEqual({ name: "Println", line: 4, receiver: "fmt" });
  });
});

describe("call-site receivers (regex tier)", () => {
  it("captures receiver-qualified, chained and bare calls in a no-grammar language", () => {
    // Kotlin ships no grammar wasm — the regex tier must carry receivers too.
    const info = extractCode("a.kt", ".kt", "fun main() {\n  client.get(url)\n  compute(1)\n  a.b.chain(2)\n}\n");
    expect(info.calls).toContainEqual({ name: "get", line: 2, receiver: "client" });
    expect(info.calls).toContainEqual({ name: "compute", line: 3 }); // bare — no receiver key
    expect(info.calls).toContainEqual({ name: "chain", line: 4, receiver: "b" });
  });
});

describe("JS/TS export parity (AST tier)", () => {
  it("CJS named exports: exports.foo values and identifier aliases", () => {
    const r = extractAst(
      "cjs.js",
      ".js",
      'exports.VERSION = "1.0";\nmodule.exports.run = function () { return 1; };\nfunction helper() { return 2; }\nexports.helper = helper;\n',
    )!;
    const by = exportedByKey(r.symbols);
    expect(by["const:VERSION"]).toBe(true); // value export emitted
    expect(by["function:run"]).toBe(true); // assignment-style definition (v4) still exported
    expect(by["function:helper"]).toBe(true); // `exports.helper = helper` marks the local decl
    expect(r.symbols.filter((s) => s.name === "helper")).toHaveLength(1); // no duplicate emission
  });

  it("module.exports = { foo, bar: baz } marks shorthand, key and value declarations", () => {
    const r = extractAst(
      "list.js",
      ".js",
      "function foo() {}\nfunction baz() {}\nfunction priv() {}\nmodule.exports = { foo, bar: baz };\n",
    )!;
    const by = exportedByKey(r.symbols);
    expect(by["function:foo"]).toBe(true);
    expect(by["function:baz"]).toBe(true);
    expect(by["function:priv"]).toBe(false);
  });

  it("module.exports = Foo marks the local declaration exported", () => {
    const r = extractAst("def.js", ".js", "class Foo {}\nmodule.exports = Foo;\n")!;
    expect(exportedByKey(r.symbols)["class:Foo"]).toBe(true);
  });

  it("export { a, b as c } marks locals and the alias surfaces as a reexport symbol", () => {
    const src = "const a = 1;\nfunction b() {}\nexport { a, b as c };\n";
    const r = extractAst("barrel.ts", ".ts", src)!;
    const by = exportedByKey(r.symbols);
    expect(by["const:a"]).toBe(true);
    expect(by["function:b"]).toBe(true);
    // The alias symbol is appended by extractCode's reexport pass (both tiers).
    const info = extractCode("barrel.ts", ".ts", src);
    expect(info.symbols.some((s) => s.name === "c" && s.kind === "reexport" && s.exported)).toBe(true);
  });

  it("anonymous export default function/class is named after the file stem", () => {
    const fn = extractAst("widget.js", ".js", "export default function () { return 1; }\n")!;
    expect(fn.symbols).toContainEqual(expect.objectContaining({ name: "widget", kind: "function", exported: true }));
    const cls = extractAst("Card.js", ".js", "export default class extends Object {}\n")!;
    expect(cls.symbols).toContainEqual(expect.objectContaining({ name: "Card", kind: "class", exported: true }));
    // A NAMED default export keeps its own name — no stem symbol.
    const named = extractAst("named.js", ".js", "export default function realName() {}\n")!;
    expect(exportedByKey(named.symbols)["function:realName"]).toBe(true);
    expect(named.symbols.some((s) => s.name === "named")).toBe(false);
  });

  it("export default Foo; marks the original declaration exported", () => {
    const r = extractAst("d.ts", ".ts", "class Foo {}\nexport default Foo;\n")!;
    expect(exportedByKey(r.symbols)["class:Foo"]).toBe(true);
  });
});

describe("JS/TS export parity (regex tier)", () => {
  it("CJS named exports emit exported consts", () => {
    const by = exportedByKey(jsTs.extract("cjs.js", 'exports.VERSION = "1.0";\nmodule.exports.run = () => 1;\n'));
    expect(by["const:VERSION"]).toBe(true);
    expect(by["const:run"]).toBe(true);
  });

  it("module.exports = { foo, bar: baz } marks shorthand, key and value declarations", () => {
    const by = exportedByKey(
      jsTs.extract("list.js", "function foo() {}\nfunction baz() {}\nfunction priv() {}\nmodule.exports = { foo, bar: baz };\n"),
    );
    expect(by["function:foo"]).toBe(true);
    expect(by["function:baz"]).toBe(true);
    expect(by["function:priv"]).toBe(false);
  });

  it("export { a, b as c } marks locals; a pure `from` re-export marks nothing", () => {
    const by = exportedByKey(jsTs.extract("barrel.ts", "const a = () => 1;\nfunction b() {}\nexport { a, b as c };\n"));
    expect(by["const:a"]).toBe(true);
    expect(by["function:b"]).toBe(true);
    const noMark = exportedByKey(jsTs.extract("x.ts", 'const a = () => 1;\nexport { a } from "./other";\n'));
    expect(noMark["const:a"]).toBe(false);
  });

  it("anonymous export default is named after the file stem", () => {
    expect(jsTs.extract("widget.js", "export default function () { return 1; }\n")).toContainEqual(
      expect.objectContaining({ name: "widget", kind: "default", exported: true }),
    );
    expect(jsTs.extract("Arrow.tsx", "export default () => null;\n")).toContainEqual(
      expect.objectContaining({ name: "Arrow", kind: "default", exported: true }),
    );
    const named = jsTs.extract("named.js", "export default function realName() {}\n");
    expect(named.some((s) => s.name === "named")).toBe(false);
  });

  it("export default Foo; marks the original and keeps the byte-compat `default` symbol", () => {
    const syms = jsTs.extract("d.ts", "class Foo {\n}\nexport default Foo;\n");
    expect(syms).toContainEqual(expect.objectContaining({ name: "Foo", kind: "class", exported: true }));
    expect(syms).toContainEqual(expect.objectContaining({ name: "Foo", kind: "default", line: 3, exported: true }));
  });
});
