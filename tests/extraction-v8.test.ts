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

// Reviewer-found CRITICAL, fixed here: the first version of this exclusion
// dropped every occurrence of a self-def name+line pair, not just the
// definition's own token — a false negative (missed sink) is worse for a
// security consumer than the false positive it fixed. `symbols` is populated
// by hand below (rather than via a real extractor) because `scan()` — shared
// by every regex-tier language, including JS/TS and C/C++ — emits at most one
// symbol per physical line, so no real extractor could produce the adversarial
// "three definitions packed on one line" fixture the regression needs; the
// point is to harden collectCallsRegex itself against that input shape.
describe("regex-tier calls keep genuine same-name-same-line occurrences (post-review fix)", () => {
  it("(d) minified one-liner: bb's calls to aa() and cc() survive even though aa/cc are also defined on line 1", () => {
    const src = "function aa(){return 1}function bb(){return aa()+cc()}function cc(){return 2}";
    const symbols = [
      { name: "aa", line: 1 },
      { name: "bb", line: 1 },
      { name: "cc", line: 1 },
    ];
    const calls = collectCallsRegex(src, symbols);
    expect(calls).toContainEqual({ name: "aa", line: 1 }); // the call inside bb's body
    expect(calls).toContainEqual({ name: "cc", line: 1 }); // the call inside bb's body
    // bb itself is never called — only ever a definition.
    expect(calls.some((call) => call.name === "bb")).toBe(false);
  });

  it("(e) one-line recursion: the genuine self-call survives", () => {
    const src = "function foo(){foo();}";
    const symbols = [{ name: "foo", line: 1 }];
    const calls = collectCallsRegex(src, symbols);
    expect(calls).toContainEqual({ name: "foo", line: 1 });
  });

  it("C fallback (no introducer keyword): one-line recursion still collects the real self-call", () => {
    // Mirrors (e) but for a language with no DEF_INTRODUCERS keyword, forcing
    // the first-occurrence fallback path rather than the introducer path.
    // `symbols` is supplied by hand: c.ts's own definition rule requires the
    // line to END right after the opening brace (no same-line body), so it
    // would never itself recognize "foo" as a symbol on this exact one-liner
    // — the point here is collectCallsRegex's fallback branch in isolation.
    const src = "void foo(void){foo();}";
    const symbols = [{ name: "foo", line: 1 }];
    const calls = collectCallsRegex(src, symbols);
    expect(calls).toContainEqual({ name: "foo", line: 1 });
  });
});
