// SCIP index export — a hand-rolled, zero-dependency protobuf wire-format
// encoder plus the codeindex→SCIP mapping and `renderScip`.
//
// Every field number and enum value below is copied VERBATIM from the pinned
// scip.proto (never guessed):
//   https://raw.githubusercontent.com/sourcegraph/scip/44d39fcfc95486d066a796e2cec8c7ec5d429aae/scip.proto
//   sourcegraph/scip @ 44d39fcfc95486d066a796e2cec8c7ec5d429aae
//
// Scope: we emit the classic packed `Occurrence.range` (field 1) that
// scip-typescript emits and that `scip stats`/`scip lint` read; the typed
// single/multi-line ranges (fields 8-11) are deliberately out of scope. The
// symbol grammar (scheme/package/descriptors and the suffixes `/` namespace,
// `#` type, `.` term, `().` method, `!` macro) is taken from the `Symbol`
// message comment.

import { join } from "node:path";
import { ENGINE_VERSION } from "../types.js";
import type { CodeSymbol, FileRecord } from "../types.js";
import type { RepoScan } from "../scan.js";
import { readText } from "../walk.js";
import { byStr } from "../sort.js";
import { importPairsFor } from "../derived.js";
import { resolveRelations } from "../relations.js";
import { manifestCoordinates } from "../workspaces.js";

export interface RenderScipOptions {
  // URI-encoded absolute path to the index root (SCIP `Metadata.project_root`).
  // Overridable so a build is byte-reproducible regardless of the machine's
  // checkout path; defaults to `file://` + the posix repo root.
  projectRoot?: string;
  // Metadata.tool_info.version. Overridable so a byte-golden fixture can pin a
  // fixed string and stay stable across ENGINE_VERSION release bumps; defaults
  // to the live ENGINE_VERSION (the CLI never overrides this — no flag for it).
  toolVersion?: string;
}

// ---------------------------------------------------------------------------
// Protobuf wire-format primitives (proto3). Messages are assembled into byte
// sinks and embedded into their parent as length-delimited (wire type 2). Only
// the two wire types we use are implemented: varint (0) and length-delimited (2).
// ---------------------------------------------------------------------------

// A growable byte buffer. This used to be a plain `number[]` — one boxed JS
// number per OUTPUT BYTE, which on a 7k-file repo cost ~176 MB of RSS to emit
// an 8 MB index. A doubling Uint8Array holds the same bytes at 1 byte each.
class Bytes {
  private buf: Uint8Array;
  private len = 0;

  constructor(capacity = 64) {
    this.buf = new Uint8Array(capacity);
  }

  get length(): number {
    return this.len;
  }

  private grow(need: number): void {
    if (this.len + need <= this.buf.length) return;
    let cap = this.buf.length * 2 || 64;
    while (cap < this.len + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  // Rewind without releasing the buffer, so a per-item scratch sink is
  // allocated once per document instead of once per occurrence/symbol.
  reset(): void {
    this.len = 0;
  }

  push(byte: number): void {
    this.grow(1);
    this.buf[this.len++] = byte;
  }

  pushAll(src: ArrayLike<number>): void {
    this.grow(src.length);
    if (src instanceof Uint8Array) this.buf.set(src, this.len);
    else for (let i = 0; i < src.length; i++) this.buf[this.len + i] = src[i]!;
    this.len += src.length;
  }

  // A view over exactly the bytes written — no copy. Callers must not retain it
  // across further writes to this sink.
  view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const utf8 = new TextEncoder();

// Unsigned LEB128. Every value we encode (field tags, enum values, ranges,
// sub-message byte lengths) is a small non-negative integer well under 2^31.
function pushVarint(out: Bytes, n: number): void {
  if (n < 0) throw new Error(`pushVarint: negative input ${n} is not a valid unsigned varint`);
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n & 0x7f);
}

function pushTag(out: Bytes, field: number, wire: number): void {
  pushVarint(out, field * 8 + wire);
}

function pushVarintField(out: Bytes, field: number, n: number): void {
  pushTag(out, field, 0);
  pushVarint(out, n);
}

function pushLenDelim(out: Bytes, field: number, payload: ArrayLike<number>): void {
  pushTag(out, field, 2);
  pushVarint(out, payload.length);
  out.pushAll(payload);
}

function pushMessage(out: Bytes, field: number, payload: Bytes): void {
  pushLenDelim(out, field, payload.view());
}

function pushString(out: Bytes, field: number, s: string): void {
  pushLenDelim(out, field, utf8.encode(s));
}

// A `repeated int32` in packed encoding: a single length-delimited blob holding
// the concatenated varints of every element (this is the piece the plain
// per-element encoding would get wrong).
function pushPackedInt32(out: Bytes, field: number, values: number[]): void {
  const payload = new Bytes(values.length * 2);
  for (const v of values) pushVarint(payload, v);
  pushMessage(out, field, payload);
}

// ---------------------------------------------------------------------------
// Pinned scip.proto field numbers & enum values (SHA 44d39fc…).
// ---------------------------------------------------------------------------
const F_INDEX_METADATA = 1;
const F_INDEX_DOCUMENTS = 2; // Index.external_symbols = 3 (unused — always empty)
const F_META_TOOL_INFO = 2; // Metadata.version = 1 is UnspecifiedProtocolVersion(0), omitted
const F_META_PROJECT_ROOT = 3;
const F_META_TEXT_ENCODING = 4;
const F_TOOL_NAME = 1;
const F_TOOL_VERSION = 2;
const F_DOC_RELPATH = 1;
const F_DOC_OCCURRENCES = 2;
const F_DOC_SYMBOLS = 3;
const F_DOC_LANGUAGE = 4;
const F_DOC_POSITION_ENCODING = 6; // Document.position_encoding = 6 (Document.text = 5 is unused — we never embed source text)
const F_OCC_RANGE = 1;
const F_OCC_SYMBOL = 2;
const F_OCC_ROLES = 3;
const F_SI_SYMBOL = 1;
const F_SI_RELATIONSHIPS = 4;
const F_SI_KIND = 5;
const F_SI_DISPLAY_NAME = 6;
// SymbolInformation.enclosing_symbol = 8 is deliberately never written: the
// proto reserves it for LOCAL symbols ("for non-local symbols, the enclosing
// symbol should be parsed from the `symbol` field"), and every symbol here is
// global — the parent is already the descriptor chain.
const F_REL_SYMBOL = 1;
const F_REL_IS_REFERENCE = 2;
const F_REL_IS_IMPLEMENTATION = 3;

const TEXT_ENCODING_UTF8 = 1; // TextEncoding.UTF8
const ROLE_DEFINITION = 0x1; // SymbolRole.Definition (a reference omits the field → 0)

// PositionEncoding.UTF16CodeUnitOffsetFromLineStart = 2. `locate`/`findWord`
// below compute range offsets with JS string `indexOf`/`.length`, i.e. UTF-16
// code units — this is the encoding that matches that computation (NOT
// Metadata.text_document_encoding, which is the on-disk file encoding and is
// unrelated to how `character` offsets in ranges are interpreted).
const POSITION_ENCODING_UTF16 = 2; // PositionEncoding.UTF16CodeUnitOffsetFromLineStart

// ---------------------------------------------------------------------------
// SCIP symbol strings (the `Symbol` grammar):
//   <scheme:codeindex> ' ' <manager> ' ' <package-name> ' ' <version> ' ' <descriptors>
// The package is the one the file's nearest manifest names (`.` placeholders
// when there is none). Descriptors: the file path as a backtick-escaped
// namespace, then the chain of enclosing declarations, then the symbol itself —
// each with the suffix its kind calls for.
// ---------------------------------------------------------------------------
const SCHEME = "codeindex";
const NO_PACKAGE = ". . .";

// The manifest naming the package a source file of each language ships in.
const PACKAGE_MANIFEST = new Map<string, string>([
  ["typescript", "package.json"],
  ["javascript", "package.json"],
  ["go", "go.mod"],
  ["rust", "Cargo.toml"],
  ["python", "pyproject.toml"],
  ["java", "pom.xml"],
  ["kotlin", "pom.xml"],
  ["scala", "pom.xml"],
  ["php", "composer.json"],
]);

// <manager>/<package-name>/<version>: any UTF-8 with spaces doubled, `.` when empty.
function packageField(value: string | undefined): string {
  return value ? value.replace(/ /g, "  ") : ".";
}

const SIMPLE_ID = /^[A-Za-z0-9_+\-$]+$/; // <identifier-character> = _ + - $ letters digits

function escapeId(name: string): string {
  // A simple-identifier is used as-is; anything else is a backtick-escaped
  // identifier (backticks doubled).
  return SIMPLE_ID.test(name) ? name : "`" + name.replace(/`/g, "``") + "`";
}

function fileNamespace(rel: string): string {
  // A repo path always contains '/' (and usually '.') so it is never a
  // simple-identifier — always backtick-escape, then the namespace suffix '/'.
  return "`" + rel.replace(/`/g, "``") + "`/";
}

// SymbolInformation.Kind and the descriptor suffix, per codeindex kind. One
// table so the two cannot drift apart: the proto requires that symbols sharing
// a Kind share a suffix (and that different suffixes mean different Kinds), so
// every Kind below appears with exactly one suffix. Enum values are copied from
// the pinned proto. A kind missing here keeps UnspecifiedKind and the term
// suffix — Terraform blocks, C++ `using`/`friend`, Scala `given`.
type Suffix = "#" | "/" | "." | "()." | "!";
// A Map, not an object literal: a kind named `constructor` must not find
// Object.prototype on the way.
const SCIP_KIND = new Map<string, readonly [kind: number, suffix: Suffix]>([
  // <type>
  ["class", [7, "#"]], // Class
  ["record", [7, "#"]], // Class — a Java/C# record is a class
  ["interface", [21, "#"]], // Interface
  ["annotation", [21, "#"]], // Interface — Java calls it an "annotation interface"
  ["enum", [11, "#"]], // Enum
  ["struct", [49, "#"]], // Struct
  ["exception", [49, "#"]], // Struct — Elixir's defexception defines a struct
  ["trait", [53, "#"]], // Trait
  ["type", [54, "#"]], // Type
  ["opaque", [54, "#"]], // Type — Zig's opaque type
  ["union", [59, "#"]], // Union
  ["protocol", [42, "#"]], // Protocol
  ["delegate", [73, "#"]], // Delegate
  ["contract", [62, "#"]], // Contract
  ["library", [64, "#"]], // Library
  ["mixin", [85, "#"]], // Mixin
  ["extension", [84, "#"]], // Extension
  ["concept", [86, "#"]], // Concept
  ["error", [63, "#"]], // Error — Solidity custom errors, Zig error sets
  // <namespace>
  ["namespace", [30, "/"]], // Namespace
  ["package", [35, "/"]], // Package
  ["module", [29, "/"]], // Module
  ["mod", [29, "/"]], // Module
  ["impl", [29, "/"]], // Module — Elixir's defimpl is a module
  // <method>
  ["function", [17, "()."]], // Function
  ["test", [17, "()."]], // Function — Zig's `test "name" {}`
  ["method", [26, "()."]], // Method
  ["def", [26, "()."]], // Method — Ruby/Scala `def`
  ["destructor", [26, "()."]], // Method
  ["fallback", [26, "()."]], // Method — Solidity's fallback()
  ["receive", [26, "()."]], // Method — Solidity's receive()
  ["call-signature", [26, "()."]], // Method
  ["constructor", [9, "()."]], // Constructor
  ["construct-signature", [9, "()."]], // Constructor
  ["getter", [18, "()."]], // Getter
  ["setter", [45, "()."]], // Setter
  ["operator", [34, "()."]], // Operator
  ["modifier", [65, "()."]], // Modifier
  ["attr", [72, "()."]], // Accessor — Ruby's attr_* declare methods
  ["indexer", [47, "()."]], // Subscript — C#'s `this[int i]`
  ["index-signature", [47, "()."]], // Subscript — TypeScript's `[key: string]: T`
  // <macro>
  ["macro", [25, "!"]], // Macro
  ["guard", [25, "!"]], // Macro — Elixir's defguard defines one
  // <term>
  ["const", [8, "."]], // Constant
  ["val", [8, "."]], // Constant
  ["var", [61, "."]], // Variable
  ["variable", [61, "."]], // Variable
  ["static", [82, "."]], // StaticVariable
  ["field", [15, "."]], // Field
  ["property", [41, "."]], // Property
  ["enum-member", [12, "."]], // EnumMember
  ["event", [13, "."]], // Event
  ["object", [33, "."]], // Object — SemanticDB (scip-java) spells a Scala object as a term
]);

const kindOf = (kind: string): number | undefined => SCIP_KIND.get(kind)?.[0];
const suffixOf = (kind: string): Suffix => SCIP_KIND.get(kind)?.[1] ?? ".";

// Declarations that can own members: the only ones a qualifier (`impl T`, a Go
// receiver) may name when the member is not lexically inside its parent.
const isContainer = (suffix: Suffix): boolean => suffix === "#" || suffix === "/";

// Guarantee a unique symbol string across the index. On a collision (overloads,
// a Python property and its setter, redefinitions) the declaration line
// disambiguates: inside the parentheses of a method — the grammar's own
// <method-disambiguator> — and as a trailing `(<line>)` parameter descriptor
// after any other suffix, the one grammar-valid place left for it.
function makeUnique(owner: string, name: string, suffix: Suffix, line: number, used: Set<string>): string {
  const id = escapeId(name);
  const base = owner + id + suffix;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 0; ; n++) {
    const disambiguator = n === 0 ? String(line) : `${line}_${n}`;
    const cand = suffix === "()." ? `${owner}${id}(${disambiguator}).` : `${base}(${disambiguator})`;
    if (!used.has(cand)) {
      used.add(cand);
      return cand;
    }
  }
}

// Collapse TS/JS (single-file components included) and C/C++ into one family
// so a reference never binds across unrelated languages (mirrors calls.ts
// `familyOf`).
function familyOf(lang: string): string {
  if (lang === "typescript" || lang === "javascript" || lang === "vue" || lang === "svelte" || lang === "astro") return "js";
  if (lang === "c" || lang === "cpp") return "c";
  return lang;
}

// A barrel re-export / default alias is a reference to a symbol declared
// elsewhere — never a call target (mirrors calls.ts REFERENCE_KINDS), and never
// a definition either: `export * from "./x"` has no name at all, and
// `from .app import Flask as Flask` defines nothing. They become reference
// occurrences of the declaration they forward, when that resolves.
const REFERENCE_KINDS = new Set(["reexport", "reexport-all", "default"]);

// ---------------------------------------------------------------------------
// Range location. CodeSymbol has no columns, so we re-read each file once and
// locate the name on its declaration line. Deterministic: same content → same
// bytes.
// ---------------------------------------------------------------------------
function isIdentByte(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 36 // $
  );
}

// [startChar, endChar) of `name` on `line`, preferring a whole-word match for a
// trivial identifier; null when not found.
function findWord(line: string, name: string): [number, number] | null {
  if (!name) return null;
  const wordy = /^[A-Za-z_$][\w$]*$/.test(name);
  let from = 0;
  for (;;) {
    const idx = line.indexOf(name, from);
    if (idx < 0) return null;
    if (!wordy) return [idx, idx + name.length];
    const before = idx > 0 ? line.charCodeAt(idx - 1) : -1;
    const afterIdx = idx + name.length;
    const after = afterIdx < line.length ? line.charCodeAt(afterIdx) : -1;
    if (!isIdentByte(before) && !isIdentByte(after)) return [idx, idx + name.length];
    from = idx + 1;
  }
}

interface Occ {
  range: number[]; // [line0, startChar, endChar]
  symbol: string;
  roles: number; // 0 = reference, ROLE_DEFINITION = definition
}

// One emitted definition. `symbol` is assigned in pass 1; `children` collects
// the definitions whose descriptor chain hangs off this one.
interface Def {
  file: FileRecord;
  sym: CodeSymbol;
  suffix: Suffix;
  symbol?: string;
  children?: Def[];
}

interface DocDefs {
  defs: Def[];
  byName: Map<string, Def[]>;
}

const endOf = (d: Def): number => d.sym.endLine ?? d.sym.line;

const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

// The directory a Go file's package lives in, plus the package clause: files of
// one directory normally share a package, but `foo_test` is a distinct one.
function goPackageKey(f: FileRecord): string {
  const pkg = f.symbols.find((s) => s.kind === "package")?.name ?? "";
  return `${dirOf(f.rel)}\u0000${pkg}`;
}

// ---------------------------------------------------------------------------
// renderScip — map a RepoScan to a SCIP Index and encode it to bytes.
// ---------------------------------------------------------------------------
export function renderScip(scan: RepoScan, opts: RenderScipOptions = {}): Uint8Array {
  const projectRoot = opts.projectRoot ?? "file://" + scan.root.replace(/\\/g, "/");
  const toolVersion = opts.toolVersion ?? ENGINE_VERSION;

  // `<manager> <name> <version>` of the nearest manifest (of the file's
  // language) at or above `dir`, memoized per directory: a manifest that names
  // nothing is skipped on the way up, the repo root ends the walk.
  const packageAt = new Map<string, string>();
  const packageOf = (dir: string, manifest: string): string => {
    const key = `${dir}\u0000${manifest}`;
    let hit = packageAt.get(key);
    if (hit === undefined) {
      const c = manifestCoordinates(scan.root, dir, manifest);
      hit = c
        ? `${packageField(c.manager)} ${packageField(c.name)} ${packageField(c.version)}`
        : dir
          ? packageOf(dirOf(dir), manifest)
          : NO_PACKAGE;
      packageAt.set(key, hit);
    }
    return hit;
  };
  const prefixOf = (f: FileRecord): string => {
    const manifest = PACKAGE_MANIFEST.get(f.lang);
    return `${SCHEME} ${manifest ? packageOf(dirOf(f.rel), manifest) : NO_PACKAGE} ${fileNamespace(f.rel)}`;
  };

  // One Document per `code` file that declares ≥1 symbol, in scan order (already
  // sorted by rel).
  const docs = scan.files.filter((f) => f.kind === "code" && f.symbols.length > 0);

  // Pass 0 — the definitions each document emits. A symbol with an empty name
  // (tree-sitter error recovery on `var { 1: } = …`) has no spelling in the
  // grammar, so it is left out rather than written as a non-canonical `` `` ``.
  const docDefs = new Map<string, DocDefs>();
  const prefixes = new Map<string, string>();
  // Go methods may sit in any file of their package: package key → type name →
  // its first top-level declaration, in scan order.
  const goTypes = new Map<string, Map<string, Def>>();
  for (const f of docs) {
    const defs: Def[] = [];
    const byName = new Map<string, Def[]>();
    for (const sym of f.symbols) {
      if (!sym.name || REFERENCE_KINDS.has(sym.kind)) continue;
      const d: Def = { file: f, sym, suffix: suffixOf(sym.kind) };
      defs.push(d);
      let arr = byName.get(sym.name);
      if (!arr) byName.set(sym.name, (arr = []));
      arr.push(d);
      if (f.lang === "go" && !sym.parent && d.suffix === "#") {
        const key = goPackageKey(f);
        let types = goTypes.get(key);
        if (!types) goTypes.set(key, (types = new Map()));
        if (!types.has(sym.name)) types.set(sym.name, d);
      }
    }
    docDefs.set(f.rel, { defs, byName });
    prefixes.set(f.rel, prefixOf(f));
  }

  // The definition a member belongs to. `parent` is only a NAME, and a name is
  // not unique in a file (two classes can each nest a `Config`), so the
  // innermost same-named declaration whose span contains the member wins. A
  // qualifier-declared member (Rust `impl T`, a Go receiver, a Scala extension)
  // is not inside its type at all: then any container of that name in the file
  // is the owner, and for Go any file of the same package. Undefined when the
  // owner was never emitted (a type from another crate, the per-file cap).
  const parentDefOf = (d: Def): Def | undefined => {
    const name = d.sym.parent;
    if (!name) return undefined;
    const local = docDefs.get(d.file.rel)!.byName.get(name) ?? [];
    let best: Def | undefined;
    for (const c of local) {
      if (c === d || c.sym.line > d.sym.line || endOf(c) < endOf(d)) continue;
      if (!best || c.sym.line > best.sym.line || (c.sym.line === best.sym.line && endOf(c) < endOf(best))) best = c;
    }
    if (best) return best;
    const containers = local.filter((c) => c !== d && isContainer(c.suffix));
    const owner = containers.find((c) => !c.sym.parent) ?? containers[0];
    if (owner) return owner;
    if (d.file.lang === "go") return goTypes.get(goPackageKey(d.file))?.get(name);
    return undefined;
  };

  // Pass 1 — every definition's final symbol string, built from its parent's
  // FINAL string (so a nested member carries the whole ancestor chain, each link
  // with its own suffix: `create_app().index().`, `celery_init_app().FlaskTask#`).
  // Memoized recursion in scan order keeps the collision disambiguators stable.
  // A parent that was never emitted keeps the old single-level `Parent#`
  // descriptor under this file.
  const used = new Set<string>();
  const inProgress = new Set<Def>();
  const symbolOf = (d: Def): string => {
    if (d.symbol !== undefined) return d.symbol;
    inProgress.add(d);
    const parent = parentDefOf(d);
    // A containment cycle (two same-line declarations naming each other) is
    // broken at the second visit instead of recursing forever.
    const owner =
      parent && !inProgress.has(parent)
        ? symbolOf(parent)
        : prefixes.get(d.file.rel)! + (d.sym.parent ? escapeId(d.sym.parent) + "#" : "");
    inProgress.delete(d);
    d.symbol = makeUnique(owner, d.sym.name, d.suffix, d.sym.line, used);
    if (parent && owner === parent.symbol) (parent.children ??= []).push(d);
    return d.symbol;
  };

  // Index the exported defs by name so references can be resolved against
  // globally-unique names.
  const defByName = new Map<string, { symbolString: string; family: string }[]>();
  for (const f of docs) {
    for (const d of docDefs.get(f.rel)!.defs) {
      const symbolString = symbolOf(d);
      if (!d.sym.exported) continue;
      let arr = defByName.get(d.sym.name);
      if (!arr) defByName.set(d.sym.name, (arr = []));
      arr.push({ symbolString, family: familyOf(d.sym.lang) });
    }
  }

  // Implementation relationships, from the inheritance relations.ts already
  // resolves (same binding rules as the call graph). A subtype points at every
  // supertype it extends or implements — `is_implementation` for both, as
  // scip-typescript and scip-java emit for a base class too, so "Find
  // implementations" on a base lists its subclasses. A method overriding a
  // same-named method of that supertype also gets `is_reference`, so "Find
  // references" on the contract's method includes the implementations' call
  // sites. Keyed by target symbol: `scip lint` flags a pair stated twice.
  const relationships = new Map<Def, Map<string, boolean>>(); // def → target → is_reference
  const relate = (from: Def, to: Def, isReference: boolean): void => {
    if (from === to) return;
    let targets = relationships.get(from);
    if (!targets) relationships.set(from, (targets = new Map()));
    targets.set(to.symbol!, isReference || targets.get(to.symbol!) === true);
  };
  for (const r of resolveRelations(scan, importPairsFor(scan))) {
    // The subtype is the declaration the relation was stated on, or the one
    // enclosing it (a Ruby `include`); a Rust `impl Trait for T` sits outside
    // T, so any non-callable declaration of that name in the file will do.
    const subs = (docDefs.get(r.fromFile)?.byName.get(r.from) ?? []).filter((d) => d.suffix !== "()." && d.suffix !== "!");
    const sub =
      subs.find((d) => d.sym.line === r.fromLine) ??
      subs.filter((d) => d.sym.line <= r.fromLine && endOf(d) >= r.fromLine).pop() ??
      subs[0];
    // relations.ts binds the target to the FIRST type-kinded declaration of
    // that name in the file; the same pick here.
    const sup = docDefs.get(r.toFile)?.byName.get(r.to)?.find((d) => d.sym.kind === r.toKind);
    if (!sub || !sup) continue;
    relate(sub, sup, false);
    const inherited = new Map<string, Def>();
    for (const m of sup.children ?? []) if (m.suffix === "()." && !inherited.has(m.sym.name)) inherited.set(m.sym.name, m);
    for (const m of sub.children ?? []) {
      const overridden = m.suffix === "()." ? inherited.get(m.sym.name) : undefined;
      if (overridden) relate(m, overridden, true);
    }
  }

  // A call resolves to a reference only when the name is defined exactly once in
  // the whole index and in the caller's language family (conservative, like
  // resolveCallEdges — ambiguous names are skipped).
  const resolveRef = (name: string, callerFamily: string): string | undefined => {
    const cands = defByName.get(name);
    if (!cands || cands.length !== 1) return undefined;
    const only = cands[0]!;
    return only.family === callerFamily ? only.symbolString : undefined;
  };

  // Pass 2 — encode each Document.
  const documents: Bytes[] = [];
  for (const f of docs) {
    const text = readText(join(scan.root, f.rel));
    const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    const locate = (lineNo: number, name: string): number[] => {
      const line = lines[lineNo - 1];
      if (line === undefined) return [lineNo - 1, 0, 0];
      const r = findWord(line, name);
      return r ? [lineNo - 1, r[0], r[1]] : [lineNo - 1, 0, line.length];
    };

    const { defs } = docDefs.get(f.rel)!;
    const occs: Occ[] = [];
    for (const d of defs) {
      occs.push({ range: locate(d.sym.line, d.sym.name), symbol: d.symbol!, roles: ROLE_DEFINITION });
    }
    const callerFamily = familyOf(f.lang);
    for (const c of f.calls ?? []) {
      const target = resolveRef(c.name, callerFamily);
      if (!target) continue;
      occs.push({ range: locate(c.line, c.name), symbol: target, roles: 0 });
    }
    // A re-export names what it forwards: a reference to that declaration, but
    // only where the name is really written on the line — the regex tier names
    // an anonymous `export default` after the file stem, which is not.
    for (const s of f.symbols) {
      if (!REFERENCE_KINDS.has(s.kind) || !s.name) continue;
      const line = lines[s.line - 1];
      const r = line === undefined ? null : findWord(line, s.name);
      const target = r && resolveRef(s.name, callerFamily);
      if (!r || !target) continue;
      occs.push({ range: [s.line - 1, r[0], r[1]], symbol: target, roles: 0 });
    }
    // A barrel whose every symbol forwarded something unresolvable has nothing
    // left to say.
    if (!occs.length) continue;
    // Deterministic occurrence order + dedupe of exact duplicates.
    occs.sort(
      (a, b) =>
        a.range[0]! - b.range[0]! ||
        a.range[1]! - b.range[1]! ||
        a.range[2]! - b.range[2]! ||
        a.roles - b.roles ||
        byStr(a.symbol, b.symbol),
    );
    const seenOcc = new Set<string>();

    // One SymbolInformation per definition, sorted by symbol string.
    const infos = defs
      .map((d) => ({
        symbol: d.symbol!,
        displayName: d.sym.name,
        kind: kindOf(d.sym.kind),
        relationships: [...(relationships.get(d) ?? [])].sort((a, b) => byStr(a[0], b[0])),
      }))
      .sort((a, b) => byStr(a.symbol, b.symbol));

    const doc = new Bytes(1024);
    pushString(doc, F_DOC_RELPATH, f.rel);
    const ob = new Bytes(64);
    for (const o of occs) {
      const key = `${o.range.join(",")} ${o.roles} ${o.symbol}`;
      if (seenOcc.has(key)) continue;
      seenOcc.add(key);
      ob.reset();
      pushPackedInt32(ob, F_OCC_RANGE, o.range);
      pushString(ob, F_OCC_SYMBOL, o.symbol);
      if (o.roles !== 0) pushVarintField(ob, F_OCC_ROLES, o.roles);
      pushMessage(doc, F_DOC_OCCURRENCES, ob);
    }
    const sb = new Bytes(64);
    const rb = new Bytes(64);
    for (const si of infos) {
      sb.reset();
      pushString(sb, F_SI_SYMBOL, si.symbol);
      for (const [target, isReference] of si.relationships) {
        rb.reset();
        pushString(rb, F_REL_SYMBOL, target);
        if (isReference) pushVarintField(rb, F_REL_IS_REFERENCE, 1);
        pushVarintField(rb, F_REL_IS_IMPLEMENTATION, 1);
        pushMessage(sb, F_SI_RELATIONSHIPS, rb);
      }
      if (si.kind !== undefined) pushVarintField(sb, F_SI_KIND, si.kind);
      pushString(sb, F_SI_DISPLAY_NAME, si.displayName);
      pushMessage(doc, F_DOC_SYMBOLS, sb);
    }
    pushString(doc, F_DOC_LANGUAGE, f.lang);
    pushVarintField(doc, F_DOC_POSITION_ENCODING, POSITION_ENCODING_UTF16);
    documents.push(doc);
  }

  // Metadata { tool_info, project_root, text_document_encoding }.
  const toolInfo = new Bytes();
  pushString(toolInfo, F_TOOL_NAME, "codeindex");
  pushString(toolInfo, F_TOOL_VERSION, toolVersion);

  const metadata = new Bytes();
  pushMessage(metadata, F_META_TOOL_INFO, toolInfo);
  pushString(metadata, F_META_PROJECT_ROOT, projectRoot);
  pushVarintField(metadata, F_META_TEXT_ENCODING, TEXT_ENCODING_UTF8);

  // Index { metadata, documents }.
  let total = 0;
  for (const d of documents) total += d.length;
  const index = new Bytes(total + metadata.length + 16);
  pushMessage(index, F_INDEX_METADATA, metadata);
  for (const d of documents) pushMessage(index, F_INDEX_DOCUMENTS, d);

  return index.toUint8Array();
}
