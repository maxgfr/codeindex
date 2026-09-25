import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanRepo } from "../src/scan.js";
import { findSymbol } from "../src/query.js";
import { insertAfterSymbol, insertBeforeSymbol, replaceSymbolBody, resolveUniqueSymbol } from "../src/edit.js";
import { readTextEx } from "../src/text.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repo(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "codeindex-edit-safety-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}
const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

describe("regex-tier symbols (no AST end line)", () => {
  const swift =
    "import Foundation\n\nfunc area(width: Double, height: Double) -> Double {\n    let w = width\n    let h = height\n    return w * h\n}\n\nfunc perimeter(width: Double, height: Double) -> Double {\n    return 2 * (width + height)\n}\n";

  it("replaces the whole brace-matched declaration, not just its first line", () => {
    const root = repo({ "shapes.swift": swift });
    const scan = scanRepo(root);
    // The premise: a regex-tier symbol. That tier now bounds a formatted brace
    // body itself, at the closing brace the edit's own matcher would find.
    expect(findSymbol(scan, "area")[0]).toMatchObject({ lang: "swift", endLine: 7 });
    expect(findSymbol(scan, "area")[0]!.signature).toBe("func area(width: Double, height: Double) -> Double {");
    const result = replaceSymbolBody(scan, "area", "func area(width: Double, height: Double) -> Double {\n    return width * height\n}");
    expect(result).toMatchObject({ startLine: 3, endLine: 5 });
    expect(result.warnings).toBeUndefined();
    expect(read(root, "shapes.swift")).toBe(
      "import Foundation\n\nfunc area(width: Double, height: Double) -> Double {\n    return width * height\n}\n\nfunc perimeter(width: Double, height: Double) -> Double {\n    return 2 * (width + height)\n}\n",
    );
  });

  it("inserts after the closing brace, not inside the body", () => {
    const root = repo({ "shapes.swift": swift });
    insertAfterSymbol(scanRepo(root), "area", "func volume() -> Double {\n    return 0\n}");
    expect(read(root, "shapes.swift")).toContain("    return w * h\n}\n\nfunc volume() -> Double {\n    return 0\n}\n\nfunc perimeter");
  });

  it("handles a Dart expression body ending in a semicolon", () => {
    const root = repo({ "util.dart": "int add(int a, int b) {\n  final s = a + b;\n  return s;\n}\n\nint sub(int a, int b) {\n  return a - b;\n}\n" });
    replaceSymbolBody(scanRepo(root), "add", "int add(int a, int b) => a + b;");
    expect(read(root, "util.dart")).toBe("int add(int a, int b) => a + b;\n\nint sub(int a, int b) {\n  return a - b;\n}\n");
    replaceSymbolBody(scanRepo(root), "add", "int add(int a, int b) {\n  return a + b;\n}");
    expect(read(root, "util.dart")).toBe("int add(int a, int b) {\n  return a + b;\n}\n\nint sub(int a, int b) {\n  return a - b;\n}\n");
  });

  it("refuses, writing nothing, when the end cannot be proven", () => {
    const source = "protocol Shape {\n    func area() -> Double\n    func name() -> String\n}\n";
    const root = repo({ "p.swift": source });
    const scan = scanRepo(root);
    expect(() => replaceSymbolBody(scan, "area", "    func area() -> Int")).toThrow(/cannot tell where "area" ends.*regex tier/);
    expect(() => insertAfterSymbol(scan, "area", "    func extra()")).toThrow(/cannot tell where/);
    expect(read(root, "p.swift")).toBe(source);
    // Inserting before needs no end line.
    insertBeforeSymbol(scan, "area", "    func first()");
    expect(read(root, "p.swift")).toBe("protocol Shape {\n\n    func first()\n\n    func area() -> Double\n    func name() -> String\n}\n");
  });
});

describe("insert_before lands above decorators and doc comments", () => {
  it("keeps a Python decorator on its own method", () => {
    const root = repo({ "a.py": "class S:\n    def other(self):\n        pass\n\n    # routes\n    @setupmethod\n    def route(self):\n        return 1\n" });
    const result = insertBeforeSymbol(scanRepo(root), "S/route", "    def helper(self):\n        return 0");
    expect(read(root, "a.py")).toBe(
      "class S:\n    def other(self):\n        pass\n\n    def helper(self):\n        return 0\n\n    # routes\n    @setupmethod\n    def route(self):\n        return 1\n",
    );
    expect(result).toMatchObject({ startLine: 5, endLine: 7 });
    expect(result.warnings).toBeUndefined();
  });

  it("keeps a godoc comment attached to its function", () => {
    const root = repo({ "run.go": "package x\n\n// Run attaches the router.\n// It blocks.\nfunc Run() {}\n" });
    insertBeforeSymbol(scanRepo(root), "Run", "func Helper() {}");
    expect(read(root, "run.go")).toBe("package x\n\nfunc Helper() {}\n\n// Run attaches the router.\n// It blocks.\nfunc Run() {}\n");
  });

  it("keeps TypeScript decorators and JSDoc with the class and method", () => {
    const src = "/** A widget. */\n@Component({\n  selector: 'w',\n})\nexport class Widget {\n  @HostListener('click')\n  onClick() {\n    return 1;\n  }\n}\n";
    const root = repo({ "w.ts": src });
    insertBeforeSymbol(scanRepo(root), "Widget", "export const before = 1;");
    expect(read(root, "w.ts")).toBe(`export const before = 1;\n\n${src}`);
    insertBeforeSymbol(scanRepo(root), "Widget/onClick", "  helper() {\n    return 0;\n  }");
    expect(read(root, "w.ts")).toContain("export class Widget {\n\n  helper() {\n    return 0;\n  }\n\n  @HostListener('click')\n  onClick() {");
  });
});

describe("resolution", () => {
  it("finds a file-qualified definition past the 50th same-named match", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`p${String(i).padStart(2, "0")}/s.go`] = "package p\n\nfunc String() string {\n\treturn \"x\"\n}\n";
    const root = repo(files);
    const scan = scanRepo(root);
    expect(resolveUniqueSymbol(scan, "String", "p59/s.go").file).toBe("p59/s.go");
    // The spellings an agent sends for the same file.
    expect(resolveUniqueSymbol(scan, "String", "./p59/s.go").file).toBe("p59/s.go");
    expect(resolveUniqueSymbol(scan, "String", join(root, "p59/s.go")).file).toBe("p59/s.go");
    // The ambiguity message counts every match but lists a bounded few.
    expect(() => resolveUniqueSymbol(scan, "String")).toThrow(/60 matches: .*p19\/s\.go:3, … 40 more/);
  });

  it("selects same-file homonyms by `line` and says so when it is missing", () => {
    const src =
      "class App:\n    @property\n    def debug(self) -> bool:\n        return self._debug\n\n    @debug.setter\n    def debug(self, value: bool) -> None:\n        self._debug = value\n";
    const root = repo({ "app.py": src });
    const scan = scanRepo(root);
    expect(() => replaceSymbolBody(scan, "App/debug", "x", "app.py")).toThrow(/2 declarations in app\.py, lines 3, 7\) — pass `line`: one of 3, 7/);
    expect(resolveUniqueSymbol(scan, "App/debug", undefined, 7).line).toBe(7);
    expect(resolveUniqueSymbol(scan, "App/debug", undefined, 8).line).toBe(7); // any line inside the span
    expect(() => resolveUniqueSymbol(scan, "App/debug", undefined, 5)).toThrow(/spans line 5 — candidates: app\.py:3, app\.py:7/);
    const result = replaceSymbolBody(scan, "App/debug", "    def debug(self, value: bool) -> None:\n        self._debug = bool(value)", "app.py", { line: 7 });
    expect(result.warnings).toBeUndefined();
    expect(read(root, "app.py")).toBe(src.replace("self._debug = value", "self._debug = bool(value)"));
  });

  it("refuses a scan that predates an earlier edit instead of splicing stale lines", () => {
    const src = "export function a(): number {\n  return 1;\n}\n\nexport function b(): number {\n  return 2;\n}\n";
    const root = repo({ "x.ts": src });
    const scan = scanRepo(root);
    insertAfterSymbol(scan, "a", "export const c = 3;");
    const edited = read(root, "x.ts");
    expect(() => replaceSymbolBody(scan, "b", "export function b(): number {\n  return 3;\n}")).toThrow(/no longer declared at x\.ts:5.*re-scan/);
    expect(read(root, "x.ts")).toBe(edited);
  });
});

describe("encodings and line endings", () => {
  it("keeps valid UTF-8 that contains U+FFFD as UTF-8", () => {
    const root = repo({ "f.ts": "// \uFFFD marker\nexport function eta(): string {\n  return \"x\";\n}\n" });
    expect(readTextEx(join(root, "f.ts")).encoding).toBe("utf8");
    replaceSymbolBody(scanRepo(root), "eta", 'export function eta(): string {\n  return "é€😀";\n}');
    expect(read(root, "f.ts")).toBe('// \uFFFD marker\nexport function eta(): string {\n  return "é€😀";\n}\n');
  });

  it("still reads invalid UTF-8 as Latin-1", () => {
    const root = repo({ "l.ts": Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0x0a]) });
    expect(readTextEx(join(root, "l.ts"))).toMatchObject({ encoding: "latin1", text: "// é\n" });
  });

  it("leaves every untouched line ending of a mixed-EOL file alone", () => {
    const src = "export function gamma(): number {\r\n  return 1;\r\n}\r\n\nexport function delta(): number {\n  return 2;\n}\n";
    const root = repo({ "m.ts": src });
    replaceSymbolBody(scanRepo(root), "delta", "export function delta(): number {\n  return 20;\n}");
    expect(read(root, "m.ts")).toBe(src.replace("return 2;", "return 20;"));
    replaceSymbolBody(scanRepo(root), "gamma", "export function gamma(): number {\n  return 10;\n}");
    expect(read(root, "m.ts")).toBe(src.replace("return 2;", "return 20;").replace("return 1;", "return 10;"));
  });

  it("preserves a missing final newline when appending after the last symbol", () => {
    const root = repo({ "n.ts": "export function iota(): number {\n  return 1;\n}" });
    insertAfterSymbol(scanRepo(root), "iota", "export function iota2(): number {\n  return 2;\n}");
    expect(read(root, "n.ts")).toBe("export function iota(): number {\n  return 1;\n}\n\nexport function iota2(): number {\n  return 2;\n}");
  });

  it("adds no blank line above the first line of a file", () => {
    const root = repo({ "t.ts": "export function first(): number {\n  return 1;\n}\n" });
    insertBeforeSymbol(scanRepo(root), "first", "export function zero(): number {\n  return 0;\n}");
    expect(read(root, "t.ts")).toBe("export function zero(): number {\n  return 0;\n}\n\nexport function first(): number {\n  return 1;\n}\n");
  });
});

describe("post-edit verification", () => {
  const py =
    "class Flask:\n    def app_context(self):\n        return AppContext(self)\n\n    def request_context(self, environ):\n        return RequestContext(self, environ)\n\n    def wsgi_app(self, environ):\n        return self.request_context(environ)\n";

  it("warns when the edit re-parents declarations outside the edited lines", () => {
    const root = repo({ "app.py": py });
    const result = replaceSymbolBody(scanRepo(root), "Flask/app_context", "def app_context(self):\n    return AppContext(self)");
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings![0]).toMatch(/changed declarations outside lines 2-3: lost .*Flask\/request_context.*gained .*app_context\/request_context/);
    expect(result.warnings![1]).toBe('"Flask/app_context" is no longer declared in lines 2-3');
    expect(read(root, "app.py")).not.toBe(py); // written: warnings do not block by default
  });

  it("refuses the same edit under strict, leaving the file untouched", () => {
    const root = repo({ "app.py": py });
    expect(() =>
      replaceSymbolBody(scanRepo(root), "Flask/app_context", "def app_context(self):\n    return AppContext(self)", undefined, { strict: true }),
    ).toThrow(/edit refused \(strict\), nothing written: the edit changed declarations/);
    expect(read(root, "app.py")).toBe(py);
  });

  it("reports new syntax errors, but not ones the file already had", () => {
    const src = "export function a(): number {\n  return 1;\n}\n\nexport function b(): number {\n  return 2;\n}\n";
    const root = repo({ "x.ts": src });
    const broken = replaceSymbolBody(scanRepo(root), "a", "export function a(): number {\n  return (1;\n}");
    expect(broken.warnings).toEqual(["the edited file has 1 new syntax error(s), first at line 2"]);
    // The error is now pre-existing: a clean edit elsewhere does not re-report it.
    expect(replaceSymbolBody(scanRepo(root), "b", "export function b(): number {\n  return 3;\n}").warnings).toBeUndefined();
  });

  it("lets an indented method appended to a Python class grow the class", () => {
    const root = repo({ "app.py": py });
    const result = insertAfterSymbol(scanRepo(root), "Flask/wsgi_app", "    def __call__(self, environ):\n        return self.wsgi_app(environ)");
    expect(result.warnings).toBeUndefined();
    expect(findSymbol(scanRepo(root), "Flask/__call__")).toHaveLength(1);
  });
});
