import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generatedKind, isBundle, isMinified } from "../src/extract/generated.js";
import { extractCode } from "../src/extract/code.js";
import { scanRepo } from "../src/scan.js";
import { buildArtifactsFromScan } from "../src/pipeline.js";
import { buildCallerIndex } from "../src/callers.js";

// Build output not named *.min.js went through full extraction: a 373KB
// minified bundle gave 1234 one- and two-letter symbols (`zf`, `O`, `lo`) and
// 512 call sites in ~0.5s, and this repo's own esbuild bundle redefined every
// function of src/. Both are now detected from their content, indexed with
// their summary and imports only, and flagged — never dropped.

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
    expect(info.generated).toBe("minified");
    expect(info.symbols).toEqual([]);
    expect(info.calls).toBeUndefined();
    expect(info.terms).toBeUndefined();
    expect(info.refs.map((r) => r.spec)).toEqual(["./dep.js", "./other.js"]);
    expect(info.summary).toBe("demo v1.0.0 | MIT License");
    // Ordinary code is untouched.
    const ordinary = extractCode("lib.js", ".js", ORDINARY);
    expect(ordinary.generated).toBeUndefined();
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
    expect(record.generated).toBe("minified");
    expect(record.symbols).toEqual([]);
    expect(scan.files.filter((f) => f.generated).map((f) => f.rel)).toEqual(["public/bundle.js"]);
    const { graph } = buildArtifactsFromScan(scan);
    expect(graph.files.find((f) => f.rel === "public/bundle.js")?.generated).toBe("minified");
    expect(graph.files.find((f) => f.rel === "public/dep.js")).not.toHaveProperty("generated");
    expect(graph.fileEdges.map((e) => `${e.from} -${e.kind}-> ${e.to}`)).toEqual([
      "public/bundle.js -import-> public/dep.js",
      "public/bundle.js -import-> public/other.js",
    ]);
  });
});

// esbuild (tsup, Vite library mode, Bun) output: each inlined module opens with
// a comment naming its source, then its code, all of it readable.
const UTIL = "export function helper(x) {\n  return x + 1;\n}\nexport function unused() {}\n";
const ESBUILD = [
  "#!/usr/bin/env node",
  'import { readFileSync } from "fs";',
  "",
  "// src/util.ts",
  "function helper(x) {",
  "  return x + 1;",
  "}",
  "function unused() {}",
  "",
  "// src/text.ts",
  "var SEP = \"\\n\";",
  "",
  "// src/main.ts",
  "function main() {",
  "  return helper(readFileSync(0, \"utf8\").split(SEP).length);",
  "}",
  "export {",
  "  main",
  "};",
].join("\n");

describe("isBundle", () => {
  it("recognises esbuild's module banners and webpack's loader", () => {
    expect(isBundle(".mjs", ESBUILD)).toBe(true);
    expect(generatedKind(".mjs", ESBUILD)).toBe("bundle");
    const webpack = [
      "/******/ (() => { // webpackBootstrap",
      "/******/ \tvar __webpack_modules__ = ({ 1: ((module) => { module.exports = 1; }) });",
      "/******/ \tfunction __webpack_require__(moduleId) {",
      "/******/ \t\treturn __webpack_modules__[moduleId](moduleId);",
      "/******/ \t}",
      "/******/ })();",
    ].join("\n");
    expect(isBundle(".js", webpack)).toBe(true);
    // ncc renames the loader.
    expect(isBundle(".js", webpack.replaceAll("__webpack_require__", "__nccwpck_require__"))).toBe(true);
  });

  it("leaves source alone: two section comments, quoted banners, a loader named in a string, TypeScript", () => {
    // Two path comments could be a hand-written file's section headers.
    const two = ESBUILD.split("\n").filter((l) => l !== "// src/text.ts").join("\n");
    expect(isBundle(".mjs", two)).toBe(false);
    // A generator that writes such a bundle holds its banners in a template.
    const generator = `export const fixture = \`\n${ESBUILD.replace("#!/usr/bin/env node\n", "")}\n\`;\nexport function write() {}\n`;
    expect(isBundle(".js", generator)).toBe(false);
    expect(isBundle(".js", 'const hint = "function __webpack_require__(id)";\nexport function f() {}')).toBe(false);
    expect(isBundle(".ts", ESBUILD)).toBe(false);
    expect(generatedKind(".js", ORDINARY)).toBeUndefined();
  });

  it("indexes a bundle without its copies of the sources' definitions", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-bundle-"));
    const files: Record<string, string> = {
      "src/util.ts": UTIL,
      "src/run.ts": 'import { helper } from "./util";\nexport function run() {\n  return helper(1);\n}\n',

      "scripts/engine.mjs": ESBUILD,
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const scan = scanRepo(root);
    const bundle = scan.files.find((f) => f.rel === "scripts/engine.mjs")!;
    expect(bundle.generated).toBe("bundle");
    expect(bundle.symbols).toEqual([]);
    expect(bundle.refs.map((r) => r.spec)).toEqual(["fs"]);
    const { graph } = buildArtifactsFromScan(scan);
    expect(graph.files.find((f) => f.rel === "scripts/engine.mjs")?.generated).toBe("bundle");
    expect(graph.fileEdges.map((e) => `${e.from} -${e.kind}-> ${e.to}`)).toEqual([
      "src/run.ts -call-> src/util.ts",
      "src/run.ts -import-> src/util.ts",
    ]);
    // With the bundle's copy indexed, `helper` had two definitions and the bare
    // name answered with the bundle's (it sorts first), called only from inside
    // the bundle. Now the name has one definition, and its real caller.
    const helper = [...buildCallerIndex(scan)].filter(([key]) => key.startsWith("helper"));
    expect(helper.map(([key, e]) => `${key} ${e.def.file} <- ${e.callers.map((c) => c.file).join(",")}`)).toEqual([
      "helper src/util.ts <- src/run.ts",
    ]);
  });
});
