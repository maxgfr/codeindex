// Validate persisted extraction records once, at the JSON boundary. Both CLI
// indexing and session preload must reject the same corrupt cache; TypeScript
// assertions alone do not make a stat-matching record safe to reuse.
import { EXTRACTOR_VERSION, SCHEMA_VERSION } from "./types.js";
import type { FileRecord } from "./types.js";

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
  return object(v) && (v.kind === "import" || v.kind === "doc-link") && string(v.spec);
}

function call(v: unknown): boolean {
  return object(v) && string(v.name) && line(v.line) && (v.receiver === undefined || string(v.receiver));
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
    optionalArray(v.calls, call) && optionalArray(v.relations, relation) && optionalArray(v.literals, literal) &&
    (v.truncated === undefined || v.truncated === true);
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
