// Validate persisted extraction records once, at the JSON boundary. Both CLI
// indexing and session preload must reject the same corrupt cache; TypeScript
// assertions alone do not make a stat-matching record safe to reuse.
import { EXTRACTOR_VERSION, SCHEMA_VERSION } from "./types.js";
import type { FileRecord } from "./types.js";
import { grammarKeyForExt, grammarKeysForExts } from "./ast/loader.js";

export type PersistedCacheEntry = { hash: string; record: FileRecord; size?: number; mtimeMs?: number };
export type PersistedCacheMap = Map<string, PersistedCacheEntry>;

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string";
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const line = (v: unknown): v is number => count(v) && v > 0;
const strings = (v: unknown): boolean => Array.isArray(v) && v.every(string);
const sha = (v: unknown): v is string => string(v) && /^[a-f0-9]{40}$/.test(v);
const kinds = new Set(["code", "doc", "config", "asset", "other"]);
const symbolText = ["parent", "parentPath", "signature", "doc"];
const fileText = ["title", "summary", "pkg"];
const fileLists = ["idents", "importedNames", "terms"];

function optionalFields(v: ObjectValue, keys: string[], valid: (value: unknown) => boolean): boolean {
  return keys.every((key) => v[key] === undefined || valid(v[key]));
}

function symbol(v: unknown, rel: string): boolean {
  return object(v) && string(v.name) && string(v.kind) && v.file === rel && line(v.line) &&
    (v.endLine === undefined || (line(v.endLine) && v.endLine >= v.line)) &&
    typeof v.exported === "boolean" && string(v.lang) && optionalFields(v, symbolText, string);
}

function ref(v: unknown): boolean {
  return object(v) && (v.kind === "import" || v.kind === "doc-link") && string(v.spec) &&
    (v.soft === undefined || v.soft === true);
}

function call(v: unknown): boolean {
  return object(v) && string(v.name) && line(v.line) && (v.receiver === undefined || string(v.receiver));
}

function importAlias(v: unknown): boolean {
  return object(v) && string(v.local) && string(v.name) && (v.from === undefined || string(v.from));
}

function relation(v: unknown): boolean {
  return object(v) && (v.kind === "extends" || v.kind === "implements") &&
    string(v.from) && string(v.to) && line(v.line);
}

function literal(v: unknown): boolean {
  return object(v) && (v.kind === "string" || v.kind === "number" || v.kind === "regex") &&
    string(v.value) && line(v.line);
}

function optionalArray(value: unknown, valid: (item: unknown) => boolean): boolean {
  return value === undefined || (Array.isArray(value) && value.every(valid));
}

function record(v: unknown, rel: string): v is FileRecord {
  return object(v) && v.rel === rel && string(v.ext) && count(v.size) && count(v.lines) &&
    sha(v.hash) && string(v.kind) && kinds.has(v.kind) && string(v.lang) &&
    optionalFields(v, fileText, string) && optionalFields(v, fileLists, strings) &&
    strings(v.headings) && Array.isArray(v.symbols) && v.symbols.every((s) => symbol(s, rel)) &&
    Array.isArray(v.refs) && v.refs.every(ref) &&
    optionalArray(v.calls, call) && optionalArray(v.importAliases, importAlias) && optionalArray(v.relations, relation) && optionalArray(v.literals, literal) &&
    (v.truncated === undefined || v.truncated === true) && (v.generated === undefined || v.generated === "minified" || v.generated === "bundle");
}

function entry(v: unknown, rel: string): v is PersistedCacheEntry {
  return object(v) && sha(v.hash) && record(v.record, rel) && v.hash === v.record.hash &&
    (v.size === undefined || (count(v.size) && v.size === v.record.size)) &&
    (v.mtimeMs === undefined || (typeof v.mtimeMs === "number" && Number.isFinite(v.mtimeMs)));
}

// An invalid entry invalidates the WHOLE cache, including any artifact fastpath.
// Do not repair records or silently drop bad fields: doing so could turn a
// corrupt cache into a contentUnchanged proof for unrelated graph/symbol bytes.
export function parseCacheEntries(value: unknown): PersistedCacheMap | undefined {
  if (!object(value) || value.schemaVersion !== SCHEMA_VERSION || value.extractorVersion !== EXTRACTOR_VERSION ||
      !object(value.files)) return undefined;
  const cache: PersistedCacheMap = new Map();
  for (const [rel, candidate] of Object.entries(value.files)) {
    if (rel.split("/").some((part) => part === "" || part === "." || part === "..") || !entry(candidate, rel)) {
      return undefined;
    }
    cache.set(rel, candidate);
  }
  return cache;
}

// How a persisted cache's CODE records were extracted: the part of their
// provenance that (schemaVersion, extractorVersion) does not capture. Those pin
// the extractor's code, not the configuration it ran under — and the same
// engine gives a code file different symbols, calls and relations at the AST
// tier than at the regex tier, and a different call list under another
// --max-calls. Neither shows in the (size, mtime) / content-hash freshness
// keys, so an index built with --no-ast, before a grammar was pulled, or with
// another --max-calls kept serving those records (and "unchanged — artifacts
// reused") until each file happened to be edited. Persisted as cache.json's
// additive `extraction` meta by `codeindex index`.
export interface ExtractionProfile {
  // Grammar keys whose code files were extracted at the AST tier, sorted.
  grammars: string[];
  // ScanOptions.maxCallsPerFile exactly as given; absent = the extractor
  // default. Not normalized on purpose: an explicit value equal to the default
  // costs one re-extraction, never a wrong record.
  maxCallsPerFile?: number;
}

// The profile a scan's records were extracted under. `ast` answers, per
// grammar key, whether this run extracted at the AST tier — grammarReady when
// the scan has already run, since extractAst gates on exactly that.
export function extractionProfile(
  files: readonly Pick<FileRecord, "kind" | "ext">[],
  maxCallsPerFile: number | undefined,
  ast: (key: string) => boolean,
): ExtractionProfile {
  const grammars = grammarKeysForExts(files.filter((f) => f.kind === "code").map((f) => f.ext)).filter(ast);
  return maxCallsPerFile === undefined ? { grammars } : { grammars, maxCallsPerFile };
}

export function sameExtractionProfile(a: ExtractionProfile | undefined, b: ExtractionProfile): boolean {
  return a !== undefined && a.maxCallsPerFile === b.maxCallsPerFile && a.grammars.join(",") === b.grammars.join(",");
}

// Lenient where the entries are strict: a malformed profile says nothing about
// any record, so it reads as absent and compatibleEntries drops the code
// entries — the per-file records it does not describe are never trusted.
export function parseExtractionProfile(value: unknown): ExtractionProfile | undefined {
  if (!object(value) || !Array.isArray(value.grammars) || !value.grammars.every(string)) return undefined;
  const calls = value.maxCallsPerFile;
  if (calls !== undefined && !(typeof calls === "number" && Number.isFinite(calls) && calls > 0)) return undefined;
  const grammars = [...(value.grammars as string[])];
  return calls === undefined ? { grammars } : { grammars, maxCallsPerFile: calls };
}

// The persisted entries a scan extracting under `current` would reproduce.
// Only code records depend on the profile, and only through their own grammar
// key, so a mismatch drops exactly the affected entries: those files are
// re-extracted like new ones, everything else keeps its stat fastpath, and the
// scan's contentUnchanged (hence every artifact fastpath) fails as it must. A
// cache with no profile — written before it was recorded — proves nothing
// about any code record.
export function compatibleEntries(
  cache: PersistedCacheMap,
  stored: ExtractionProfile | undefined,
  current: { maxCallsPerFile?: number; ast: (key: string) => boolean },
): PersistedCacheMap {
  const alike = extractedAlike(stored, current);
  const kept: PersistedCacheMap = new Map();
  for (const [rel, entry] of cache) {
    if (alike(entry.record.kind, entry.record.ext)) kept.set(rel, entry);
  }
  return kept;
}

// The per-file test behind compatibleEntries, on a file's (kind, ext) alone —
// what freshness.json keeps of a record (see freshness.ts).
export function extractedAlike(
  stored: ExtractionProfile | undefined,
  current: { maxCallsPerFile?: number; ast: (key: string) => boolean },
): (kind: string, ext: string) => boolean {
  const astBefore = new Set(stored?.grammars);
  const callsMatch = stored !== undefined && stored.maxCallsPerFile === current.maxCallsPerFile;
  return (kind, ext) => {
    if (kind !== "code") return true;
    if (!callsMatch) return false;
    const key = grammarKeyForExt(ext);
    return key === undefined || astBefore.has(key) === current.ast(key);
  };
}
