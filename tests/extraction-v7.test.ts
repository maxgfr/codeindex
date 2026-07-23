import { describe, expect, it } from "vitest";
import { extractCode } from "../src/extract/code.js";

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
    // At the export statement's line, not the original declaration's line.
    expect(alias?.line).toBe(3);
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
  });

  it("an alias whose original isn't a resolvable local declaration keeps the reexport kind", () => {
    // `x` is never declared in this file (e.g. a destructured/ambient global) —
    // extractReexports can't mirror a kind it never saw.
    const src = "export { x as y };\n";
    const info = extractCode("odd.ts", ".ts", src);
    const alias = info.symbols.find((s) => s.name === "y");
    expect(alias).toBeDefined();
    expect(alias?.kind).toBe("reexport");
  });
});
