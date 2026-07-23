import { describe, expect, it } from "vitest";
import { collectCallsRegex } from "../src/extract/code.js";
import { c } from "../src/lang/c.js";

// EXTRACTOR_VERSION 8: the C/C++ regex tier no longer reports a function
// DEFINITION as a call to itself. Found during the ultrasec consumer
// migration: `void load(void) {` on its own definition line was emitted as a
// call `load@<defline>` — for a security tool walking FileRecord.calls this
// manufactures a fake sink hit on every sink-named function definition (open,
// read, system, exec, load, …), independent of whether the function is ever
// actually called. JS/TS/Python are unaffected: their DEF_INTRODUCERS keyword
// (function/def/func/fn/…) already excludes the definition line; C/C++
// definitions have no such introducer keyword (`<type> name(args) {`), so the
// fix cross-references the file's OWN extracted symbols (name + line) instead.
//
// The AST tier (tree-sitter, when the wasm sidecar is present) never had this
// bug — function_definition and call_expression are distinct node types there.
// This is purely a regex-tier fix, so the tests exercise collectCallsRegex
// directly (extractCode would use the AST tier in this suite, since the c/cpp
// grammars are committed and loaded by tests/setup.ts).

describe("C/C++ regex-tier calls exclude the file's own definition line (extractor v8)", () => {
  it("C: a function definition yields no self-call, a real call elsewhere is collected, and a call inside another definition's body is collected", () => {
    const src = [
      "void load(void) {",
      "  int z = 1;",
      "}",
      "",
      "void run(void) {",
      "  load();",
      "  static int y = helper();",
      "}",
    ].join("\n");
    const symbols = c.extract("a.c", src);
    const calls = collectCallsRegex(src, symbols);

    // (a) no spurious self-call at the definition line (line 1) — nor at
    // run's own definition line (line 5).
    expect(calls.some((call) => call.name === "load" && call.line === 1)).toBe(false);
    expect(calls.some((call) => call.name === "run" && call.line === 5)).toBe(false);

    // (b) a genuine call to load() elsewhere is still collected.
    expect(calls).toContainEqual({ name: "load", line: 6 });

    // (c) a mixed definition-body line still collects the real call it makes.
    expect(calls).toContainEqual({ name: "helper", line: 7 });
  });

  it("C++: same shape (std:: return type, top-level free functions)", () => {
    const src = [
      "std::string load() {",
      '  return "x";',
      "}",
      "",
      "void run() {",
      "  load();",
      "  static std::string y = helper();",
      "}",
    ].join("\n");
    const symbols = c.extract("a.cpp", src);
    const calls = collectCallsRegex(src, symbols);

    expect(calls.some((call) => call.name === "load" && call.line === 1)).toBe(false);
    expect(calls.some((call) => call.name === "run" && call.line === 5)).toBe(false);
    expect(calls).toContainEqual({ name: "load", line: 6 });
    expect(calls).toContainEqual({ name: "helper", line: 7 });
  });
});
