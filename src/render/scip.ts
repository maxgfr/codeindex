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
// `#` type, `.` term, `().` method) is taken from the `Symbol` message comment.

import { join } from "node:path";
import { ENGINE_VERSION } from "../types.js";
import type { CodeSymbol } from "../types.js";
import type { RepoScan } from "../scan.js";
import { readText } from "../walk.js";
import { byStr } from "../sort.js";

export interface RenderScipOptions {
  // URI-encoded absolute path to the index root (SCIP `Metadata.project_root`).
  // Overridable so a build is byte-reproducible regardless of the machine's
  // checkout path; defaults to `file://` + the posix repo root.
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Protobuf wire-format primitives (proto3). Messages are assembled as plain
// number[] byte buffers and embedded into their parent as length-delimited
// (wire type 2). Only the two wire types we use are implemented: varint (0)
// and length-delimited (2).
// ---------------------------------------------------------------------------
type Bytes = number[];
const utf8 = new TextEncoder();

// Unsigned LEB128. Every value we encode (field tags, enum values, ranges,
// sub-message byte lengths) is a small non-negative integer well under 2^31.
function pushVarint(out: Bytes, n: number): void {
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
  for (let i = 0; i < payload.length; i++) out.push(payload[i]!);
}

function pushString(out: Bytes, field: number, s: string): void {
  pushLenDelim(out, field, utf8.encode(s));
}

// A `repeated int32` in packed encoding: a single length-delimited blob holding
// the concatenated varints of every element (this is the piece the plain
// per-element encoding would get wrong).
function pushPackedInt32(out: Bytes, field: number, values: number[]): void {
  const payload: Bytes = [];
  for (const v of values) pushVarint(payload, v);
  pushLenDelim(out, field, payload);
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
const F_OCC_RANGE = 1;
const F_OCC_SYMBOL = 2;
const F_OCC_ROLES = 3;
const F_SI_SYMBOL = 1;
const F_SI_KIND = 5;
const F_SI_DISPLAY_NAME = 6;
const F_SI_ENCLOSING = 8;

const TEXT_ENCODING_UTF8 = 1; // TextEncoding.UTF8
const ROLE_DEFINITION = 0x1; // SymbolRole.Definition (a reference omits the field → 0)

// SymbolInformation.Kind — only the codeindex kinds we can map; anything else
// leaves the field unset (UnspecifiedKind = 0).
const KIND: Record<string, number> = {
  function: 17, // Function
  method: 26, // Method
  class: 7, // Class
  interface: 21, // Interface
  enum: 11, // Enum
  struct: 49, // Struct
  trait: 53, // Trait
  type: 54, // Type
  const: 8, // Constant
  var: 61, // Variable
};

// ---------------------------------------------------------------------------
// SCIP symbol strings (the `Symbol` grammar). Local, minimal scheme:
//   <scheme:codeindex> ' ' <manager:.> ' ' <package-name:.> ' ' <version:.> ' ' <descriptors>
// Descriptors: the file path as a backtick-escaped namespace, an optional parent
// type descriptor, then the symbol with a kind-dependent suffix.
// ---------------------------------------------------------------------------
const SYMBOL_PREFIX = "codeindex . . . ";
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

// Enclosing members hang off their parent, which we model as a type descriptor.
function parentDescriptor(parent: string): string {
  return escapeId(parent) + "#";
}

const TYPE_KINDS = new Set(["class", "interface", "enum", "struct", "trait", "type"]);
const METHOD_KINDS = new Set(["function", "method", "def"]);

function suffixFor(kind: string): string {
  if (TYPE_KINDS.has(kind)) return "#"; // <type>
  if (METHOD_KINDS.has(kind)) return "()."; // <method>
  return "."; // <term> — const/var/reexport/… default
}

function baseSymbol(rel: string, sym: CodeSymbol): string {
  let s = SYMBOL_PREFIX + fileNamespace(rel);
  if (sym.parent) s += parentDescriptor(sym.parent);
  return s + escapeId(sym.name) + suffixFor(sym.kind);
}

function enclosingSymbolOf(rel: string, parent: string): string {
  return SYMBOL_PREFIX + fileNamespace(rel) + parentDescriptor(parent);
}

// Guarantee a unique symbol string per document. On a same name+kind collision
// we append a `(<disambiguator>)` parameter descriptor — grammar-valid after any
// suffix (type/term/method) and deterministic (seeded by the declaration line).
function makeUnique(base: string, line: number, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 0; ; n++) {
    const disambiguator = n === 0 ? String(line) : `${line}_${n}`;
    const cand = `${base}(${disambiguator})`;
    if (!used.has(cand)) {
      used.add(cand);
      return cand;
    }
  }
}

// Collapse TS/JS and C/C++ into one family so a reference never binds across
// unrelated languages (mirrors calls.ts `familyOf`).
function familyOf(lang: string): string {
  if (lang === "typescript" || lang === "javascript") return "js";
  if (lang === "c" || lang === "cpp") return "c";
  return lang;
}

// A barrel re-export / default alias is a reference to a symbol declared
// elsewhere — never a call target (mirrors calls.ts REFERENCE_KINDS).
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

interface DefEntry {
  sym: CodeSymbol;
  symbolString: string;
}

// ---------------------------------------------------------------------------
// renderScip — map a RepoScan to a SCIP Index and encode it to bytes.
// ---------------------------------------------------------------------------
export function renderScip(scan: RepoScan, opts: RenderScipOptions = {}): Uint8Array {
  const projectRoot = opts.projectRoot ?? "file://" + scan.root.replace(/\\/g, "/");

  // One Document per `code` file that declares ≥1 symbol, in scan order (already
  // sorted by rel).
  const docs = scan.files.filter((f) => f.kind === "code" && f.symbols.length > 0);

  // Pass 1 — assign every symbol its final (per-document-unique) symbol string,
  // and index the exported, non-reference-kind defs by name so references can be
  // resolved against globally-unique names.
  const docDefs = new Map<string, DefEntry[]>();
  const defByName = new Map<string, { symbolString: string; family: string }[]>();
  for (const f of docs) {
    const used = new Set<string>();
    const entries: DefEntry[] = [];
    for (const sym of f.symbols) {
      const symbolString = makeUnique(baseSymbol(f.rel, sym), sym.line, used);
      entries.push({ sym, symbolString });
      if (sym.exported && !REFERENCE_KINDS.has(sym.kind)) {
        let arr = defByName.get(sym.name);
        if (!arr) defByName.set(sym.name, (arr = []));
        arr.push({ symbolString, family: familyOf(sym.lang) });
      }
    }
    docDefs.set(f.rel, entries);
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

    const entries = docDefs.get(f.rel)!;
    const occs: Occ[] = [];
    for (const { sym, symbolString } of entries) {
      occs.push({ range: locate(sym.line, sym.name), symbol: symbolString, roles: ROLE_DEFINITION });
    }
    const callerFamily = familyOf(f.lang);
    for (const c of f.calls ?? []) {
      const target = resolveRef(c.name, callerFamily);
      if (!target) continue;
      occs.push({ range: locate(c.line, c.name), symbol: target, roles: 0 });
    }
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
    const infos = entries
      .map(({ sym, symbolString }) => ({
        symbol: symbolString,
        displayName: sym.name,
        kind: KIND[sym.kind],
        enclosing: sym.parent ? enclosingSymbolOf(f.rel, sym.parent) : undefined,
      }))
      .sort((a, b) => byStr(a.symbol, b.symbol));

    const doc: Bytes = [];
    pushString(doc, F_DOC_RELPATH, f.rel);
    for (const o of occs) {
      const key = `${o.range.join(",")} ${o.roles} ${o.symbol}`;
      if (seenOcc.has(key)) continue;
      seenOcc.add(key);
      const ob: Bytes = [];
      pushPackedInt32(ob, F_OCC_RANGE, o.range);
      pushString(ob, F_OCC_SYMBOL, o.symbol);
      if (o.roles !== 0) pushVarintField(ob, F_OCC_ROLES, o.roles);
      pushLenDelim(doc, F_DOC_OCCURRENCES, ob);
    }
    for (const si of infos) {
      const sb: Bytes = [];
      pushString(sb, F_SI_SYMBOL, si.symbol);
      if (si.kind !== undefined) pushVarintField(sb, F_SI_KIND, si.kind);
      pushString(sb, F_SI_DISPLAY_NAME, si.displayName);
      if (si.enclosing) pushString(sb, F_SI_ENCLOSING, si.enclosing);
      pushLenDelim(doc, F_DOC_SYMBOLS, sb);
    }
    pushString(doc, F_DOC_LANGUAGE, f.lang);
    documents.push(doc);
  }

  // Metadata { tool_info, project_root, text_document_encoding }.
  const toolInfo: Bytes = [];
  pushString(toolInfo, F_TOOL_NAME, "codeindex");
  pushString(toolInfo, F_TOOL_VERSION, ENGINE_VERSION);

  const metadata: Bytes = [];
  pushLenDelim(metadata, F_META_TOOL_INFO, toolInfo);
  pushString(metadata, F_META_PROJECT_ROOT, projectRoot);
  pushVarintField(metadata, F_META_TEXT_ENCODING, TEXT_ENCODING_UTF8);

  // Index { metadata, documents }.
  const index: Bytes = [];
  pushLenDelim(index, F_INDEX_METADATA, metadata);
  for (const d of documents) pushLenDelim(index, F_INDEX_DOCUMENTS, d);

  return Uint8Array.from(index);
}
