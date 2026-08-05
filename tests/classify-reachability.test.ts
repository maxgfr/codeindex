import { describe, it, expect } from "vitest";
import { EXT_GRAMMAR } from "../src/ast/loader.js";
import { classify, isCode } from "../src/classify.js";
import { languageOf } from "../src/lang/registry.js";
import { categorize } from "../src/categorize.js";

// The quality harness calls extractCode DIRECTLY, so it can publish a perfect
// score for a language a real scan never reaches: `classify` gates extraction,
// and it reads `languageOf`, not the grammar table. Terraform, Solidity and Zig
// shipped grammars and a published symbolsF1 of 1 while every real scan
// classified them "other" and extracted nothing.
//
// This test binds the two tables together so the gap cannot reopen: anything
// the AST tier claims to parse must survive classification as code.
describe("classification reachability", () => {
  it("every extension with an AST grammar classifies as code", () => {
    const unreachable = Object.keys(EXT_GRAMMAR).filter((ext) => !isCode(ext));
    expect(unreachable).toEqual([]);
  });

  it("every extension with an AST grammar has a language label", () => {
    const unlabelled = Object.keys(EXT_GRAMMAR).filter((ext) => languageOf(ext) === "other");
    expect(unlabelled).toEqual([]);
  });

  it("classify and categorize agree that grammar extensions are code", () => {
    const disagreeing = Object.keys(EXT_GRAMMAR).filter(
      (ext) => classify(`sample${ext}`, ext) !== "code" || categorize(`sample${ext}`, ext) !== "code",
    );
    expect(disagreeing).toEqual([]);
  });

  it("the previously unreachable extensions are reachable", () => {
    for (const ext of [".tf", ".tfvars", ".hcl", ".sol", ".zig"]) {
      expect(classify(`main${ext}`, ext), ext).toBe("code");
    }
  });
});
