import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isMinified } from "../src/extract/minified.js";
import { extractCode } from "../src/extract/code.js";
import { scanRepo } from "../src/scan.js";
import { buildArtifactsFromScan } from "../src/pipeline.js";

// Minified JS not named *.min.js went through full extraction: a 373KB bundle
// gave 1234 one- and two-letter symbols (`zf`, `O`, `lo`) and 512 call sites in
// ~0.5s. It is now detected from its content, indexed with its summary and
// imports only, and flagged — never dropped.

// Terser-style output: no whitespace but where a keyword needs it, statements
// run together, 30 functions per physical line.
function minifiedLine(seed: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 30; i++) {
    const n = `f${seed}_${i}`;
    parts.push(`function ${n}(n,t){for(var r=-1,e=null==n?0:n.length;++r<e;)if(t(n[r],r,n))return r;return-1}`);
  }
  return parts.join("");
}
const MINIFIED = [
  "/*! demo v1.0.0 | MIT License */",
  'import{a as b}from"./dep.js";const x=require("./other.js");' + minifiedLine(0),
  minifiedLine(1),
  minifiedLine(2),
].join("\n");

// Ordinary code: one statement per line, spaces between tokens.
const ORDINARY = Array.from({ length: 40 }, (_, i) => `export function g${i}(a, b) {\n  return a + b * ${i};\n}`).join("\n");

describe("isMinified", () => {
  it("flags terser-style output and 500-column wrapped output (uglify, lodash.min.js)", () => {
    expect(isMinified(".js", MINIFIED)).toBe(true);
    expect(isMinified(".mjs", MINIFIED)).toBe(true);
    const wrapped = minifiedLine(3).match(/.{1,500}/g)!.join("\n");
    expect(isMinified(".cjs", wrapped)).toBe(true);
  });

  it("leaves ordinary code alone, whatever its long lines hold", () => {
    expect(isMinified(".js", ORDINARY)).toBe(false);
    // A long data literal is text, not code: a base64 blob, a long template.
    expect(isMinified(".js", `const WASM = "${"QUJD".repeat(20000)}";\n${ORDINARY}`)).toBe(false);
    expect(isMinified(".js", `const CSS = \`${"a{b:c}".repeat(5000)}\`;\n${ORDINARY}`)).toBe(false);
    // A one-line numeric table (no statements, no calls) is data too.
    const table = `const T = [${Array.from({ length: 2000 }, (_, i) => i).join(",")}];`;
    expect(isMinified(".js", `${table}\n${ORDINARY}`)).toBe(false);
    // Compiled, not minified: tsc's inlined helpers are long lines with spaces.
    const helper =
      'var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) { function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); } return new (P || (P = Promise))(function (resolve, reject) { function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } } }); };';
    expect(isMinified(".js", `${helper}\n${helper}\nexports.run = run;`)).toBe(false);
  });

  it("only considers the extensions minifiers emit", () => {
    expect(isMinified(".ts", MINIFIED)).toBe(false);
    expect(isMinified(".jsx", MINIFIED)).toBe(false);
  });
});

describe("extracting a minified file", () => {
  it("keeps the summary and the imports, drops the symbol and call noise, and says so", () => {
    const info = extractCode("vendor.js", ".js", MINIFIED);
    expect(info.minified).toBe(true);
    expect(info.symbols).toEqual([]);
    expect(info.calls).toBeUndefined();
    expect(info.terms).toBeUndefined();
    expect(info.refs.map((r) => r.spec)).toEqual(["./dep.js", "./other.js"]);
    expect(info.summary).toBe("demo v1.0.0 | MIT License");
    // Ordinary code is untouched.
    const ordinary = extractCode("lib.js", ".js", ORDINARY);
    expect(ordinary.minified).toBeUndefined();
    expect(ordinary.symbols).toHaveLength(40);
  });

  it("flags the record and its graph node, and keeps the file's import edges", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-minified-"));
    const files: Record<string, string> = {
      "public/bundle.js": MINIFIED,
      "public/dep.js": "export const b = 1;\n",
      "public/other.js": "module.exports = {};\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const scan = scanRepo(root);
    const record = scan.files.find((f) => f.rel === "public/bundle.js")!;
    expect(record.minified).toBe(true);
    expect(record.symbols).toEqual([]);
    expect(scan.files.filter((f) => f.minified).map((f) => f.rel)).toEqual(["public/bundle.js"]);
    const { graph } = buildArtifactsFromScan(scan);
    expect(graph.files.find((f) => f.rel === "public/bundle.js")?.minified).toBe(true);
    expect(graph.files.find((f) => f.rel === "public/dep.js")).not.toHaveProperty("minified");
    expect(graph.fileEdges.map((e) => `${e.from} -${e.kind}-> ${e.to}`)).toEqual([
      "public/bundle.js -import-> public/dep.js",
      "public/bundle.js -import-> public/other.js",
    ]);
  });
});
