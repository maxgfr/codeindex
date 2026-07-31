import { beforeAll, describe, expect, it } from "vitest";
import { allGrammarKeys, ensureGrammars } from "../src/ast/loader.js";
import { extractAst } from "../src/ast/extract.js";
import { extractSymbols } from "../src/lang/registry.js";

// EXTRACTOR_VERSION 12: two gaps the universal-ctags differential pointed at,
// adjudicated as real and closed here.
//
//   1. AST TIER — a declaration inside an IIFE was lost. The walk descends into
//      a node only when that node's own type is a container, and the chain for
//      `(function () { … })()` is
//        expression_statement → call_expression → parenthesized_expression →
//        function_expression → statement_block
//      Every link but `parenthesized_expression` was already listed, so the
//      descent stopped exactly one node short — the same class of one-link break
//      the `try`/`if`/callback containers were added for. Browser scripts and
//      bundled UMD/loader files are written almost entirely inside an IIFE, so
//      for those files the index was empty of functions while ctags listed them
//      (measured on socialgouv/code-du-travail-numerique's public/widget-loader.js).
//
//   2. REGEX TIER — a module-level `const`/`let`/`var` bound to a VALUE was not
//      extracted at all, while the AST tier extracts it. That divergence is the
//      one thing the regex tier must not have: it is the fallback for a repo
//      with no grammars vendored, and it silently answered "no such symbol" for
//      every module constant. The rule is anchored at column 0 rather than the
//      `^\s*` the other rules use, and that is deliberate: a line-based scanner
//      cannot see scope, and `^\s*` would sweep in every `const x = 1` inside
//      every function body — exactly the locals-flood that makes the AST tier
//      refuse them (see the `inFunctionBody` filter in ast/extract.ts). Column 0
//      is the honest proxy for module scope that a line scanner can evaluate.
//
// The tier-diff oracle (tests/oracles-tier-diff.test.ts) is what makes case 2
// safe to add: if the new rule fired where the AST tier declines, that suite's
// `astMissing` assertions would go red.

const astNames = (src: string, ext = ".ts") =>
  (extractAst("x" + ext, ext, src)?.symbols ?? []).map((s) => s.name);
const regexSyms = (src: string, ext = ".ts") => extractSymbols("x" + ext, ext, src);
const regexNames = (src: string, ext = ".ts") => regexSyms(src, ext).map((s) => s.name);

describe("EXTRACTOR_VERSION 12 — declarations inside an IIFE (AST tier)", () => {
  beforeAll(async () => {
    await ensureGrammars(allGrammarKeys());
  });

  it("indexes a function declared inside a classic IIFE", () => {
    const src = ["(function () {", "  function getLoaderScript() { return 1; }", "})();"].join("\n");
    expect(astNames(src, ".js")).toContain("getLoaderScript");
  });

  it("indexes declarations inside an arrow IIFE too", () => {
    const src = ["(() => {", "  function inArrow() {}", "  class Inner {}", "})();"].join("\n");
    const names = astNames(src, ".js");
    expect(names).toContain("inArrow");
    expect(names).toContain("Inner");
  });

  it("still refuses a VALUE binding inside that IIFE — it is a local, not a declaration", () => {
    const src = ["(function () {", "  const cfg = 1;", "  function real() {}", "})();"].join("\n");
    const names = astNames(src, ".js");
    expect(names).toContain("real");
    expect(names).not.toContain("cfg");
  });
});

describe("EXTRACTOR_VERSION 12 — module constants (regex tier)", () => {
  it("extracts a module-level const/let/var bound to a value", () => {
    const src = ["const RE_ARTICLE = /href=/g;", "let counter = 0;", "var legacy = {};"].join("\n");
    expect(regexNames(src)).toEqual(["RE_ARTICLE", "counter", "legacy"]);
  });

  it("marks them local, not exported", () => {
    const [sym] = regexSyms("const RE_ARTICLE = /href=/g;");
    expect(sym).toMatchObject({ name: "RE_ARTICLE", kind: "const", exported: false });
  });

  it("leaves an INDENTED binding alone — a line scanner cannot tell it from a local", () => {
    const src = ["function outer() {", "  const local = 1;", "  return local;", "}"].join("\n");
    expect(regexNames(src)).toEqual(["outer"]);
  });

  it("does not double-emit an exported or arrow-bound binding", () => {
    expect(regexSyms("export const B = 2;")).toHaveLength(1);
    expect(regexSyms("export const B = 2;")[0]).toMatchObject({ exported: true });
    expect(regexSyms("const f = () => 1;")).toHaveLength(1);
    expect(regexSyms("const f = () => 1;")[0]).toMatchObject({ name: "f", exported: false });
  });

  it("agrees with the AST tier on the same module constant", () => {
    const src = "const RE_ARTICLE = /href=/g;\n";
    expect(regexNames(src)).toEqual(astNames(src));
  });
});
