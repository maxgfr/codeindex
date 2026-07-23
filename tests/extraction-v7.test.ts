import { describe, expect, it } from "vitest";
import { extractCode } from "../src/extract/code.js";
import { extractReexports } from "../src/lang/common.js";
import type { CodeSymbol } from "../src/types.js";

// EXTRACTOR_VERSION 7: export-alias symbols mirror the aliased local symbol's
// kind when the original is resolvable in-file (`export { b as c }` — `c` now
// gets `b`'s own kind, e.g. "function", instead of the generic "reexport").
// A true cross-module re-export (`export { b as c } from "./mod"`) has no
// local declaration to mirror, so it keeps the existing "reexport" kind.
// Gap found during the ultradoc consumer migration: ultradoc's local
// `applyExportLists` clones the aliased symbol (kind and all) under the new
// name; the engine's own extractReexports pass only ever emitted "reexport".

describe("export-alias symbols mirror the local kind (extractor v7)", () => {
  it("`export { a, b as c }` (no `from`): the alias `c` mirrors b's kind, not the generic reexport kind", () => {
    const src = "const a = 1;\nfunction b() {}\nexport { a, b as c };\n";
    const info = extractCode("barrel.ts", ".ts", src);
    const alias = info.symbols.find((s) => s.name === "c");
    expect(alias).toBeDefined();
    expect(alias?.kind).toBe("function");
    expect(alias?.exported).toBe(true);
    // The original declaration's line (2: `function b() {}`), not the export
    // statement's line (3) — citation consumers (ultradoc) need file:line to
    // point at the actual declaration.
    expect(alias?.line).toBe(2);
  });

  it("mirrors a class alias", () => {
    const src = "class Widget {}\nexport { Widget as Gadget };\n";
    const info = extractCode("widget.ts", ".ts", src);
    const alias = info.symbols.find((s) => s.name === "Gadget");
    expect(alias).toBeDefined();
    expect(alias?.kind).toBe("class");
    expect(alias?.exported).toBe(true);
  });

  it("mirrors a const alias, regex tier (no AST grammar loaded for .mjs stem check aside)", () => {
    const src = "const a = () => 1;\nexport { a as run };\n";
    const info = extractCode("lib.ts", ".ts", src);
    const alias = info.symbols.find((s) => s.name === "run");
    expect(alias).toBeDefined();
    expect(alias?.kind).toBe("const");
  });

  it("a true cross-module re-export alias keeps the existing reexport kind (not resolvable in-file)", () => {
    const src = 'export { b as c } from "./other";\n';
    const info = extractCode("barrel.ts", ".ts", src);
    const alias = info.symbols.find((s) => s.name === "c");
    expect(alias).toBeDefined();
    expect(alias?.kind).toBe("reexport");
    expect(alias?.exported).toBe(true);
    // No local declaration to cite — keeps the export statement's own line.
    expect(alias?.line).toBe(1);
  });

  it("an alias whose original isn't a resolvable local declaration keeps the reexport kind", () => {
    // `x` is never declared in this file (e.g. a destructured/ambient global) —
    // extractReexports can't mirror a kind it never saw.
    const src = "export { x as y };\n";
    const info = extractCode("odd.ts", ".ts", src);
    const alias = info.symbols.find((s) => s.name === "y");
    expect(alias).toBeDefined();
    expect(alias?.kind).toBe("reexport");
    // Nothing to resolve `x` against — keeps the export statement's own line.
    expect(alias?.line).toBe(1);
  });
});

// Issue #9: a resolved alias didn't just mirror the original's KIND, it also
// needs to cite the original declaration's LINE (and endLine, when the AST
// tier populated one) — citation consumers (ultradoc cites file:line as
// evidence) were pointed at the export statement instead of the actual
// declaration, a precision regression. Unresolved aliases and `from`-clause
// re-exports have no declaration to point at, so they're unaffected (covered
// above).
describe("export-alias symbols cite the original declaration's line, not the export statement's (issue #9)", () => {
  it("carries the resolved declaration's endLine (AST tier) onto the alias", () => {
    // Constructing localSymbols by hand (rather than through a real
    // extractor) simulates the AST tier's endLine, the same way
    // extraction-v8.test.ts hand-builds `symbols` for collectCallsRegex.
    const src = "function b() {\n  return 1;\n}\nexport { b as c };\n";
    const localSymbols: CodeSymbol[] = [
      { name: "b", kind: "function", file: "barrel.ts", line: 1, endLine: 3, exported: false, lang: "typescript" },
    ];
    const [alias] = extractReexports("barrel.ts", src, localSymbols);
    expect(alias?.name).toBe("c");
    expect(alias?.kind).toBe("function");
    expect(alias?.line).toBe(1);
    expect(alias?.endLine).toBe(3);
  });

  it("omits endLine when the resolved declaration doesn't have one (regex tier)", () => {
    const src = "function b() {}\nexport { b as c };\n";
    const localSymbols: CodeSymbol[] = [
      { name: "b", kind: "function", file: "barrel.ts", line: 1, exported: false, lang: "typescript" },
    ];
    const [alias] = extractReexports("barrel.ts", src, localSymbols);
    expect(alias?.line).toBe(1);
    expect(alias?.endLine).toBeUndefined();
  });
});
