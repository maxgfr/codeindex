import { describe, it, expect } from "vitest";
import { extractSymbols, languageOf } from "../src/lang/registry.js";

describe("language symbol extraction", () => {
  it("extracts TypeScript declarations with export status", () => {
    const src = `export function retryRequest() {}
function helper() {}
export class HttpClient {}
export interface RetryOptions {}
export const DEFAULT = 1;
type Internal = string;`;
    const syms = extractSymbols("a.ts", ".ts", src);
    const byName = Object.fromEntries(syms.map((s) => [s.name, s]));
    expect(byName.retryRequest).toMatchObject({ kind: "function", exported: true });
    expect(byName.helper).toMatchObject({ kind: "function", exported: false });
    expect(byName.HttpClient).toMatchObject({ kind: "class", exported: true });
    expect(byName.RetryOptions).toMatchObject({ kind: "interface", exported: true });
    expect(byName.DEFAULT).toMatchObject({ kind: "const", exported: true });
    expect(byName.Internal).toMatchObject({ kind: "type", exported: false });
  });

  it("extracts Python functions/methods and respects underscore privacy", () => {
    const src = `def public_fn():
    pass

def _private():
    pass

class Thing:
    def method(self):
        pass`;
    const syms = extractSymbols("a.py", ".py", src);
    const pub = syms.find((s) => s.name === "public_fn");
    const priv = syms.find((s) => s.name === "_private");
    const method = syms.find((s) => s.name === "method");
    expect(pub).toMatchObject({ kind: "function", exported: true });
    expect(priv).toMatchObject({ exported: false });
    expect(method).toMatchObject({ kind: "method" });
  });

  it("extracts Go functions/types with uppercase = exported", () => {
    const src = `func Exported() {}
func unexported() {}
func (s *Server) Handle() {}
type Config struct {}`;
    const syms = extractSymbols("a.go", ".go", src);
    expect(syms.find((s) => s.name === "Exported")).toMatchObject({ exported: true });
    expect(syms.find((s) => s.name === "unexported")).toMatchObject({ exported: false });
    expect(syms.find((s) => s.name === "Handle")).toMatchObject({ kind: "method", exported: true });
    expect(syms.find((s) => s.name === "Config")).toMatchObject({ kind: "struct" });
  });

  it("extracts C# types and methods with visibility", () => {
    const src = `public class LoggerConfiguration {
    public Logger CreateLogger() { }
    private void Flush() { }
}
internal interface ISink { }
public enum LogLevel { }`;
    const s = extractSymbols("a.cs", ".cs", src);
    const by = Object.fromEntries(s.map((x) => [x.name, x]));
    expect(by.LoggerConfiguration).toMatchObject({ kind: "class", exported: true });
    expect(by.CreateLogger).toMatchObject({ kind: "method", exported: true });
    expect(by.Flush).toMatchObject({ exported: false });
    expect(by.ISink).toMatchObject({ kind: "interface" });
    expect(by.LogLevel).toMatchObject({ kind: "enum" });
  });

  it("extracts PHP classes and functions", () => {
    const src = `class Client {
    public function send() {}
    private function build() {}
}
interface ClientInterface {}
trait HasHeaders {}`;
    const s = extractSymbols("a.php", ".php", src);
    const by = Object.fromEntries(s.map((x) => [x.name, x]));
    expect(by.Client).toMatchObject({ kind: "class" });
    expect(by.send).toMatchObject({ kind: "function", exported: true });
    expect(by.build).toMatchObject({ exported: false });
    expect(by.ClientInterface).toMatchObject({ kind: "interface" });
    expect(by.HasHeaders).toMatchObject({ kind: "trait" });
  });

  it("extracts Elixir modules and def/defp", () => {
    const src = `defmodule Ecto.Query do
  def from(expr) do
  end
  defp build(x) do
  end
  defmacro where(q) do
  end
end`;
    const s = extractSymbols("a.ex", ".ex", src);
    const by = Object.fromEntries(s.map((x) => [x.name, x]));
    expect(by["Ecto.Query"]).toMatchObject({ kind: "module" });
    expect(by.from).toMatchObject({ kind: "function", exported: true });
    expect(by.build).toMatchObject({ kind: "function", exported: false });
    expect(by.where).toMatchObject({ kind: "macro" });
  });

  it("extracts shell functions (both syntaxes, incl. .zsh)", () => {
    const src = `function is_plugin {
  return 0
}
load_plugin() {
  echo hi
}`;
    const s = extractSymbols("plugin.zsh", ".zsh", src);
    const names = s.map((x) => x.name);
    expect(names).toContain("is_plugin");
    expect(names).toContain("load_plugin");
    expect(languageOf(".zsh")).toBe("shell");
  });

  it("extracts Swift and Kotlin declarations", () => {
    const swiftSyms = extractSymbols("a.swift", ".swift", `public func validate() {}\nstruct Request {}\nprivate func internalOnly() {}`);
    const sby = Object.fromEntries(swiftSyms.map((x) => [x.name, x]));
    expect(sby.validate).toMatchObject({ kind: "function", exported: true });
    expect(sby.Request).toMatchObject({ kind: "struct" });
    expect(sby.internalOnly).toMatchObject({ exported: false });

    const kotlinSyms = extractSymbols("a.kt", ".kt", `class ConnectionPool {\n  fun reuse() {}\n  private fun evict() {}\n}`);
    const kby = Object.fromEntries(kotlinSyms.map((x) => [x.name, x]));
    expect(kby.ConnectionPool).toMatchObject({ kind: "class" });
    expect(kby.reuse).toMatchObject({ kind: "function", exported: true });
    expect(kby.evict).toMatchObject({ exported: false });
  });

  it("returns [] for an unknown extension but still labels the language", () => {
    expect(extractSymbols("a.txt", ".txt", "hello")).toEqual([]);
    expect(languageOf(".ts")).toBe("javascript/typescript");
    expect(languageOf(".py")).toBe("python");
    expect(languageOf(".zzz")).toBe("other");
  });

  // The regex extractors below are the FALLBACK path (Ruby/C have grammars, so
  // extractCode uses tree-sitter; Lua/Scala have none). extractSymbols always
  // runs the regex extractor directly, so this covers the fallback for each.
  it("extracts Ruby methods, classes and modules (regex fallback)", () => {
    const names = extractSymbols("a.rb", ".rb", "module Api\n  class Client\n    def fetch; end\n  end\nend\n").map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["Api", "Client", "fetch"]));
  });

  it("extracts C functions and structs (regex fallback)", () => {
    const names = extractSymbols("a.c", ".c", "typedef struct Node Node;\nint compute(int x) {\n  return x;\n}\n").map((s) => s.name);
    expect(names).toContain("compute");
  });

  it("extracts Lua functions", () => {
    const names = extractSymbols("a.lua", ".lua", "function M.setup()\nend\nlocal function helper()\nend\n").map((s) => s.name);
    expect(names.length).toBeGreaterThan(0);
    expect(languageOf(".lua")).toBe("lua");
  });

  it("extracts Scala classes/objects/defs", () => {
    const names = extractSymbols("a.scala", ".scala", "object Main {\n  def run(): Unit = {}\n}\nclass Service {}\n").map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["Main", "Service"]));
  });
});
