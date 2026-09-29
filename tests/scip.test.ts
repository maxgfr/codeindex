import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo } from "../src/scan.js";
import { renderScip } from "../src/render/scip.js";
import { ENGINE_VERSION } from "../src/types.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const GOLDEN = fileURLToPath(new URL("./fixtures/scip/mini-repo.scip", import.meta.url));

// Fixed project_root so the bytes never depend on the machine's checkout path.
const PROJECT_ROOT = "file:///repo";
const render = (): Uint8Array => renderScip(scanRepo(REPO), { projectRoot: PROJECT_ROOT });

// The byte-golden fixture and the determinism check below pin tool_info.version
// to a fixed string so a release's ENGINE_VERSION bump can never invalidate
// them — see RenderScipOptions.toolVersion. The CLI-parity test deliberately
// does NOT pin: it asserts the CLI and the API embed the same (live) version.
const GOLDEN_TOOL_VERSION = "0.0.0-golden";
const renderGolden = (): Uint8Array =>
  renderScip(scanRepo(REPO), { projectRoot: PROJECT_ROOT, toolVersion: GOLDEN_TOOL_VERSION });

// ---------------------------------------------------------------------------
// A tiny protobuf reader (varint + length-delimited only) used to verify the
// encoded index without pulling in a dependency.
// ---------------------------------------------------------------------------
interface Field {
  field: number;
  wire: number;
  varint?: number;
  bytes?: Uint8Array;
}
function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    const b = buf[p++]!;
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, p];
}
function decode(buf: Uint8Array, start = 0, end = buf.length): Field[] {
  const out: Field[] = [];
  let p = start;
  while (p < end) {
    let tag: number;
    [tag, p] = readVarint(buf, p);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      let v: number;
      [v, p] = readVarint(buf, p);
      out.push({ field, wire, varint: v });
    } else if (wire === 2) {
      let len: number;
      [len, p] = readVarint(buf, p);
      out.push({ field, wire, bytes: buf.subarray(p, p + len) });
      p += len;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return out;
}
const first = (fields: Field[], n: number): Field | undefined => fields.find((f) => f.field === n);
const allOf = (fields: Field[], n: number): Field[] => fields.filter((f) => f.field === n);
const str = (f: Field | undefined): string => (f?.bytes ? new TextDecoder().decode(f.bytes) : "");
const packedInts = (f: Field | undefined): number[] => {
  if (!f?.bytes) return [];
  const nums: number[] = [];
  let p = 0;
  while (p < f.bytes.length) {
    let v: number;
    [v, p] = readVarint(f.bytes, p);
    nums.push(v);
  }
  return nums;
};

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "scip-repo-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

interface DecodedInfo {
  doc: string;
  symbol: string;
  kind?: number;
  enclosing?: string;
  relationships: { symbol: string; isReference: boolean; isImplementation: boolean }[];
}
interface DecodedOcc {
  doc: string;
  symbol: string;
  range: number[];
  definition: boolean;
}
// Every SymbolInformation and Occurrence of an index, flattened.
function decodeIndex(buf: Uint8Array): { infos: DecodedInfo[]; occs: DecodedOcc[]; docs: string[] } {
  const infos: DecodedInfo[] = [];
  const occs: DecodedOcc[] = [];
  const docs: string[] = [];
  for (const docField of allOf(decode(buf), 2)) {
    const doc = decode(docField.bytes!);
    const rel = str(first(doc, 1));
    docs.push(rel);
    for (const siField of allOf(doc, 3)) {
      const si = decode(siField.bytes!);
      infos.push({
        doc: rel,
        symbol: str(first(si, 1)),
        kind: first(si, 5)?.varint,
        enclosing: first(si, 8) ? str(first(si, 8)) : undefined,
        relationships: allOf(si, 4).map((r) => {
          const rel4 = decode(r.bytes!);
          return {
            symbol: str(first(rel4, 1)),
            isReference: first(rel4, 2)?.varint === 1,
            isImplementation: first(rel4, 3)?.varint === 1,
          };
        }),
      });
    }
    for (const occField of allOf(doc, 2)) {
      const occ = decode(occField.bytes!);
      occs.push({
        doc: rel,
        symbol: str(first(occ, 2)),
        range: packedInts(first(occ, 1)),
        definition: ((first(occ, 3)?.varint ?? 0) & 1) === 1,
      });
    }
  }
  return { infos, occs, docs };
}

describe("renderScip", () => {
  it("is deterministic: two scans + two renders are byte-identical", () => {
    const a = Buffer.from(renderGolden());
    const b = Buffer.from(renderGolden());
    expect(Buffer.compare(a, b)).toBe(0);
    expect(a.length).toBeGreaterThan(0);
  });

  it("encodes conformant metadata, documents, occurrences and symbols", () => {
    const scan = scanRepo(REPO);
    const buf = renderScip(scan, { projectRoot: PROJECT_ROOT });
    const index = decode(buf);

    // metadata.tool_info + text encoding + project_root
    const metadata = decode(first(index, 1)!.bytes!);
    const toolInfo = decode(first(metadata, 2)!.bytes!);
    expect(str(first(toolInfo, 1))).toBe("codeindex");
    expect(str(first(toolInfo, 2))).toBe(ENGINE_VERSION);
    expect(str(first(metadata, 3))).toBe(PROJECT_ROOT);
    expect(first(metadata, 4)?.varint).toBe(1); // TextEncoding.UTF8

    // one Document per code file with ≥1 symbol (a barrel whose re-exports all
    // fail to resolve would have nothing to say and is dropped — none here)
    const documents = allOf(index, 2);
    const expectedDocs = scan.files.filter((f) => f.kind === "code" && f.symbols.length > 0);
    expect(documents.length).toBe(expectedDocs.length);
    expect(documents.length).toBeGreaterThan(0);

    let totalDefs = 0;
    let totalRefs = 0;
    // <scheme> <manager> <name> <version> (spaces doubled inside a field), then
    // the file namespace and its descriptors.
    const field = "(?:[^ ]|  )+";
    const symbolPattern = new RegExp(`^codeindex ${field} ${field} ${field} \`[^\`]+\`\\/.+$`);

    for (const docField of documents) {
      const doc = decode(docField.bytes!);
      const rel = str(first(doc, 1));
      expect(rel.length).toBeGreaterThan(0);
      expect(rel.startsWith("/")).toBe(false); // path must be repo-relative
      expect(str(first(doc, 4)).length).toBeGreaterThan(0); // language

      // Every SymbolInformation in this document.
      const infoSymbols = new Set<string>();
      for (const siField of allOf(doc, 3)) {
        const si = decode(siField.bytes!);
        const symbol = str(first(si, 1));
        expect(symbol).toMatch(symbolPattern);
        expect(str(first(si, 6)).length).toBeGreaterThan(0); // display_name
        infoSymbols.add(symbol);
      }

      for (const occField of allOf(doc, 2)) {
        const occ = decode(occField.bytes!);
        const range = packedInts(first(occ, 1));
        expect(range.length).toBe(3); // [line, startChar, endChar]
        expect(range.every((n) => n >= 0)).toBe(true);
        expect(range[2]!).toBeGreaterThanOrEqual(range[1]!); // endChar >= startChar
        const symbol = str(first(occ, 2));
        expect(symbol).toMatch(symbolPattern);
        const roles = first(occ, 3)?.varint ?? 0;
        if (roles & 1) {
          totalDefs++;
          // every definition occurrence has a matching SymbolInformation here
          expect(infoSymbols.has(symbol)).toBe(true);
        } else {
          totalRefs++;
        }
      }
    }
    // The mini-repo has definitions in every document and a few cross-file refs.
    expect(totalDefs).toBeGreaterThan(0);
    expect(totalRefs).toBeGreaterThan(0);
  });

  it("declares UTF-16 position_encoding on every Document and locates ranges in UTF-16 code units", () => {
    // `café` (a 2-byte-in-UTF-8, 1-code-unit-in-UTF-16 character) sits BEFORE
    // `target` on the same declaration line, so a UTF-8 byte offset for
    // `target` would differ from its UTF-16 offset — this is what proves
    // `locate`/`findWord` (JS `indexOf`, i.e. UTF-16 code units) actually needs
    // `Document.position_encoding` declared.
    const root = mkdtempSync(join(tmpdir(), "scip-utf16-"));
    const line = 'export const café = "x", target = 1;\n';
    writeFileSync(join(root, "unicode.ts"), line);

    const scan = scanRepo(root);
    const buf = renderScip(scan, { projectRoot: PROJECT_ROOT });
    const index = decode(buf);
    const documents = allOf(index, 2);
    expect(documents.length).toBeGreaterThan(0);

    // (a) every Document carries position_encoding = UTF16CodeUnitOffsetFromLineStart (2)
    for (const docField of documents) {
      const doc = decode(docField.bytes!);
      expect(first(doc, 6)?.varint).toBe(2);
    }

    // (b) `target`'s decoded startChar is the UTF-16 (JS `.indexOf`) offset,
    // and it differs from what a UTF-8-byte-offset consumer would compute.
    let targetRange: number[] | undefined;
    for (const occField of allOf(decode(documents[0]!.bytes!), 2)) {
      const occ = decode(occField.bytes!);
      if (str(first(occ, 2)).includes("target")) {
        targetRange = packedInts(first(occ, 1));
        break;
      }
    }
    expect(targetRange).toBeDefined();

    const utf16StartChar = line.indexOf("target");
    const utf8StartChar = Buffer.byteLength(line.slice(0, utf16StartChar), "utf8");
    expect(utf16StartChar).not.toBe(utf8StartChar); // fixture actually exercises the divergence
    expect(targetRange![1]).toBe(utf16StartChar);
    expect(targetRange![1]).not.toBe(utf8StartChar);
  });

  it("references a unique definition only where the call binder binds the site to it", () => {
    // `New` is unique in the repo, but `errors.New` is the standard library's
    // and `wg.Done` (a sync.WaitGroup parameter) is not Context.Done.
    const root = mkdtempSync(join(tmpdir(), "scip-bind-"));
    writeFileSync(join(root, "go.mod"), "module example.com/app\n\ngo 1.21\n");
    writeFileSync(join(root, "gin.go"), "package app\n\nfunc New() int { return 1 }\n");
    writeFileSync(join(root, "context.go"), "package app\n\ntype Context struct{}\n\nfunc (c *Context) Done() {}\n");
    writeFileSync(
      join(root, "use.go"),
      [
        "package app",
        "",
        'import (\n\t"errors"\n\t"sync"\n)',
        "",
        'func fail() error { return errors.New("x") }',
        "",
        "func one() int { return New() }",
        "",
        "func wait(wg *sync.WaitGroup) { wg.Done() }",
        "",
      ].join("\n"),
    );
    const index = decode(renderScip(scanRepo(root), { projectRoot: PROJECT_ROOT }));
    const refs: string[] = [];
    for (const docField of allOf(index, 2)) {
      const doc = decode(docField.bytes!);
      if (str(first(doc, 1)) !== "use.go") continue;
      for (const occField of allOf(doc, 2)) {
        const occ = decode(occField.bytes!);
        if ((first(occ, 3)?.varint ?? 0) & 1) continue; // a definition
        refs.push(`${packedInts(first(occ, 1))[0]! + 1} ${str(first(occ, 2)).split("/").pop()}`);
      }
    }
    expect(refs).toEqual(["10 New()."]);
  });

  it("matches the committed golden index byte-for-byte", () => {
    const buf = Buffer.from(renderGolden());
    // Regenerate the golden after an intentional encoder/mapping change with:
    //   CODEINDEX_UPDATE_SCIP_GOLDEN=1 pnpm vitest run tests/scip.test.ts
    // (renderGolden() pins toolVersion to GOLDEN_TOOL_VERSION, so a release's
    // ENGINE_VERSION bump alone never requires — or should trigger — regen.)
    if (process.env.CODEINDEX_UPDATE_SCIP_GOLDEN) {
      writeFileSync(GOLDEN, buf);
      return;
    }
    expect(existsSync(GOLDEN)).toBe(true);
    expect(Buffer.compare(buf, readFileSync(GOLDEN))).toBe(0);
  });

  it("CLI `scip` writes a non-empty index identical to renderScip", () => {
    const out = join(mkdtempSync(join(tmpdir(), "scip-cli-")), "index.scip");
    // Both sides use the tree-sitter AST tier: the CLI warms grammars by default,
    // and tests/setup.ts warms them for the in-process renderScip above, so the
    // two extraction paths — and thus the bytes — line up.
    execFileSync(
      process.execPath,
      [CLI, "scip", "--repo", REPO, "--out", out, "--project-root", PROJECT_ROOT],
      { encoding: "utf8" },
    );
    const cliBytes = readFileSync(out);
    expect(cliBytes.length).toBeGreaterThan(0);
    expect(Buffer.compare(cliBytes, Buffer.from(render()))).toBe(0);
  });

  // Opt-in external validation with the official `scip` binary. Point at it with
  // CODEINDEX_SCIP_BIN=<path> (or have `scip` on PATH); skipped otherwise.
  const scipBin = process.env.CODEINDEX_SCIP_BIN ?? "scip";
  const scipAvailable = (): boolean => {
    try {
      execFileSync(scipBin, ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  it.skipIf(!scipAvailable())("passes `scip stats` (>0 occurrences) and `scip lint`", () => {
    const out = join(mkdtempSync(join(tmpdir(), "scip-bin-")), "index.scip");
    writeFileSync(out, render());
    const stats = execFileSync(scipBin, ["stats", "--from", out], { encoding: "utf8" });
    const parsed = JSON.parse(stats) as { occurrences?: number; documents?: number };
    expect(parsed.occurrences ?? 0).toBeGreaterThan(0);
    // lint must not fail fatally (non-zero exit throws). The polyglot repos
    // exercise every suffix, the method disambiguator and escaped package
    // fields: lint re-formats each symbol and rejects any non-canonical one.
    // (Neither holds a relationship across documents: lint checks those only
    // against the documents it has already visited, in Go map order, so they
    // fail it at random although the target is defined.)
    execFileSync(scipBin, ["lint", out], { encoding: "utf8", stdio: "pipe" });
    for (const files of [SHAPES_REPO, PACKAGES_REPO]) {
      writeFileSync(out, renderScip(scanRepo(repoWith(files)), { projectRoot: PROJECT_ROOT }));
      execFileSync(scipBin, ["lint", out], { encoding: "utf8", stdio: "pipe" });
    }
  });
});

// One small polyglot repo exercising the symbol grammar: nesting through
// functions and classes, qualifier-declared members (Rust `impl`, Go receivers
// in the same file and in a sibling file of the package), the kind → suffix
// table, overloads, and re-exports.
const SHAPES_REPO: Record<string, string> = {
  "py/app.py": [
    "class Flask:",
    "    def run(self):",
    "        pass",
    "",
    "",
    "def create_app():",
    "    def index():",
    '        return "hi"',
    "",
    "    class Task(Flask):",
    "        def __call__(self):",
    "            return 1",
    "",
    "    return index",
    "",
  ].join("\n"),
  "py/__init__.py": "from .app import Flask as Flask\nfrom .app import create_app as create_app\n",
  "pkg/context.go": "package pkg\n\ntype Context struct {\n\tName string\n}\n\nfunc (c *Context) Get() string { return c.Name }\n",
  "pkg/deprecated.go": "package pkg\n\n// BindWith is deprecated.\nfunc (c *Context) BindWith() {}\n",
  // A distinct package in the same directory, with its own `Context`.
  "pkg/other_test.go": "package pkg_test\n\ntype Context struct{}\n\nfunc (c Context) Helper() {}\n",
  "lib.rs": [
    "macro_rules! square { ($x:expr) => { $x * $x }; }",
    "pub struct Point { pub x: i32 }",
    "impl Point { pub fn new() -> Point { Point { x: 0 } } }",
    "",
  ].join("\n"),
  "shapes.ts": [
    "export namespace Geo {",
    "  export function area(): number { return 1; }",
    "}",
    "export enum Color { Red, Green }",
    "export interface Callable {",
    "  (x: number): string;",
    "  new (x: number): Callable;",
    "  [key: string]: unknown;",
    "}",
    "export class Box {",
    "  size = 1;",
    "  get width(): number { return this.size; }",
    "}",
    "export function over(a: string): void;",
    "export function over(a: number): void;",
    "export function over(a: unknown): void {}",
    // Error recovery binds an EMPTY name here — it has no spelling in the grammar.
    "var { 1: } = { 1: 2 };",
    "",
  ].join("\n"),
  "index.ts": 'export { Box } from "./shapes";\nexport * from "./shapes";\n',
};

// One manifest per ecosystem, nested where the walk up the tree matters.
const PACKAGES_REPO: Record<string, string> = {
  "package.json": '{ "name": "@acme/web", "version": "1.2.3" }\n',
  "src/a.ts": "export function a(): void {}\n",
  "src/esm/package.json": '{ "type": "module" }\n',
  "src/esm/b.ts": "export function b(): void {}\n",
  "svc/go.mod": "module example.com/svc\n\ngo 1.21\n",
  "svc/main.go": "package main\n\nfunc Main() {}\n",
  "crates/core/Cargo.toml": '[package]\nname = "core-lib"\nversion = "0.4.0"\n',
  "crates/core/src/lib.rs": "pub fn core() {}\n",
  "py/pyproject.toml": '[project]\nname = "odd name"\nversion = "2.0"\n',
  "py/m.py": "def hello():\n    pass\n",
  "native/n.c": "int native_fn(void) { return 1; }\n",
};

const P = "codeindex . . . ";
const shapes = (() => {
  let cached: ReturnType<typeof decodeIndex> | undefined;
  return () => (cached ??= decodeIndex(renderScip(scanRepo(repoWith(SHAPES_REPO)), { projectRoot: PROJECT_ROOT })));
})();

describe("renderScip symbol structure", () => {
  it("builds a nested member from its parent's own symbol and suffix", () => {
    const { infos } = shapes();
    const defined = new Set(infos.map((i) => i.symbol));
    for (const s of [
      // A function's members hang off the FUNCTION symbol, not a phantom type.
      "`py/app.py`/create_app().index().",
      "`py/app.py`/create_app().Task#",
      // Two levels deep: the whole ancestor chain, each link with its own suffix.
      "`py/app.py`/create_app().Task#__call__().",
      // A Rust impl block and a same-file Go receiver bind to the declared type.
      "`lib.rs`/Point#new().",
      "`pkg/context.go`/Context#Get().",
      // The `_test` package's own Context, not pkg's.
      "`pkg/other_test.go`/Context#Helper().",
    ]) {
      expect(defined).toContain(P + s);
    }
    // A Go method declared in a sibling file of the package belongs to the type
    // declared there; its SymbolInformation stays in the file that declares it.
    expect(infos.find((i) => i.symbol === P + "`pkg/context.go`/Context#BindWith().")?.doc).toBe("pkg/deprecated.go");
    expect(defined).not.toContain(P + "`pkg/deprecated.go`/Context#BindWith().");

    // Every owner in a descriptor chain is itself a defined symbol (the file
    // namespace aside), and no global symbol carries enclosing_symbol — the proto
    // reserves that field for local symbols.
    const lastDescriptor = /(?:`(?:[^`]|``)+`|[A-Za-z0-9_+\-$]+)(?:\(\w*\)\.|[#./!])$/;
    const fileNamespace = /^codeindex \. \. \. `(?:[^`]|``)+`\/$/;
    for (const info of infos) {
      expect(info.enclosing).toBeUndefined();
      const owner = info.symbol.replace(lastDescriptor, "");
      expect(owner).not.toBe(info.symbol);
      if (!fileNamespace.test(owner)) expect(defined).toContain(owner);
    }
  });

  it("gives every kind its SCIP Kind and the descriptor suffix that goes with it", () => {
    const { infos } = shapes();
    const kindOf = new Map(infos.map((i) => [i.symbol, i.kind]));
    const expected: Record<string, number> = {
      "`shapes.ts`/Geo/": 30, // Namespace
      "`shapes.ts`/Geo/area().": 17, // Function
      "`shapes.ts`/Color#": 11, // Enum
      "`shapes.ts`/Color#Red.": 12, // EnumMember
      "`shapes.ts`/Callable#": 21, // Interface
      "`shapes.ts`/Callable#`(call)`().": 26, // Method
      "`shapes.ts`/Callable#`(construct)`().": 9, // Constructor
      "`shapes.ts`/Callable#`[key]`().": 47, // Subscript
      "`shapes.ts`/Box#": 7, // Class
      "`shapes.ts`/Box#size.": 41, // Property
      "`pkg/context.go`/pkg/": 35, // Package
      "`pkg/context.go`/Context#Name.": 15, // Field
      "`lib.rs`/square!": 25, // Macro
      "`lib.rs`/Point#": 49, // Struct
    };
    for (const [s, kind] of Object.entries(expected)) expect(kindOf.get(P + s), s).toBe(kind);
    expect(infos.filter((i) => i.kind === undefined).map((i) => i.symbol)).toEqual([]);

    // Overloads are told apart by the grammar's own method disambiguator, not a
    // parameter descriptor tacked onto the method.
    const overloads = infos.filter((i) => i.symbol.includes("/over(")).map((i) => i.symbol.slice(P.length));
    expect(overloads.sort()).toEqual(["`shapes.ts`/over().", "`shapes.ts`/over(15).", "`shapes.ts`/over(16)."]);

    // The empty-named binding is left out instead of written as `` `` ``.
    expect(infos.filter((i) => i.symbol.includes("``"))).toEqual([]);
  });

  it("turns a re-export into a reference to what it forwards, not a definition", () => {
    const { infos, occs } = shapes();
    // Barrels define nothing: no `* (./shapes)`, no second `Box`.
    expect(infos.filter((i) => i.doc === "index.ts" || i.doc === "py/__init__.py")).toEqual([]);
    expect(infos.filter((i) => i.symbol.includes("* (./shapes)"))).toEqual([]);

    const refsIn = (doc: string) =>
      occs.filter((o) => o.doc === doc && !o.definition).map((o) => [o.symbol.slice(P.length), o.range]);
    expect(refsIn("index.ts")).toEqual([["`shapes.ts`/Box#", [0, 9, 12]]]);
    expect(refsIn("py/__init__.py")).toEqual([
      ["`py/app.py`/Flask#", [0, 17, 22]],
      ["`py/app.py`/create_app().", [1, 17, 27]],
    ]);
  });
});

describe("renderScip relationships and package identity", () => {
  it("points a subtype and its overriding methods at what they implement", () => {
    const root = repoWith({
      "src/contract.ts": "export interface Runnable {\n  start(): void;\n}\n",
      "src/base.ts": "export abstract class Base {\n  abstract start(): void;\n  stop(): void {}\n}\n",
      "src/worker.ts": [
        'import { Runnable } from "./contract";',
        'import { Base } from "./base";',
        "export class Worker extends Base implements Runnable {",
        "  start(): void {}",
        "  stop(): void {}",
        "  other(): void {}",
        "}",
        "",
      ].join("\n"),
      // A trait implemented outside the type's own declaration.
      "shape.rs": "pub trait Shape { fn area(&self) -> f64; }\npub struct Sq;\nimpl Shape for Sq { fn area(&self) -> f64 { 1.0 } }\n",
    });
    const { infos } = decodeIndex(renderScip(scanRepo(root), { projectRoot: PROJECT_ROOT }));
    const relsOf = (s: string) =>
      infos
        .find((i) => i.symbol === P + s)
        ?.relationships.map((r) => [r.symbol.slice(P.length), r.isImplementation, r.isReference]);

    // The type itself: an implementation of each supertype, never a reference
    // (Find references on Base must not list Worker).
    expect(relsOf("`src/worker.ts`/Worker#")).toEqual([
      ["`src/base.ts`/Base#", true, false],
      ["`src/contract.ts`/Runnable#", true, false],
    ]);
    // An overriding method: implementation AND reference of every same-named
    // method up the hierarchy.
    expect(relsOf("`src/worker.ts`/Worker#start().")).toEqual([
      ["`src/base.ts`/Base#start().", true, true],
      ["`src/contract.ts`/Runnable#start().", true, true],
    ]);
    expect(relsOf("`src/worker.ts`/Worker#stop().")).toEqual([["`src/base.ts`/Base#stop().", true, true]]);
    expect(relsOf("`src/worker.ts`/Worker#other().")).toEqual([]);
    expect(relsOf("`shape.rs`/Sq#")).toEqual([["`shape.rs`/Shape#", true, false]]);
    expect(relsOf("`shape.rs`/Sq#area().")).toEqual([["`shape.rs`/Shape#area().", true, true]]);

    // Every relationship names a symbol the index defines.
    const defined = new Set(infos.map((i) => i.symbol));
    for (const i of infos) for (const r of i.relationships) expect(defined).toContain(r.symbol);
  });

  it("names each symbol's package after the nearest manifest of its language", () => {
    const root = repoWith(PACKAGES_REPO);
    const { infos } = decodeIndex(renderScip(scanRepo(root), { projectRoot: PROJECT_ROOT }));
    const packageOf = (doc: string) => {
      const symbols = [...new Set(infos.filter((i) => i.doc === doc).map((i) => i.symbol.slice(0, i.symbol.indexOf(" `"))))];
      expect(symbols).toHaveLength(1);
      return symbols[0];
    };
    expect(packageOf("src/a.ts")).toBe("codeindex npm @acme/web 1.2.3");
    // A nested package.json that names nothing does not start a new package.
    expect(packageOf("src/esm/b.ts")).toBe("codeindex npm @acme/web 1.2.3");
    expect(packageOf("svc/main.go")).toBe("codeindex gomod example.com/svc .");
    expect(packageOf("crates/core/src/lib.rs")).toBe("codeindex cargo core-lib 0.4.0");
    // Spaces inside a package field are doubled, as the grammar requires.
    expect(packageOf("py/m.py")).toBe("codeindex python odd  name 2.0");
    // No manifest for the language (go.mod does not name a C file's package).
    expect(packageOf("native/n.c")).toBe("codeindex . . .");
  });
});
