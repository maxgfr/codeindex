// An in-memory POSIX filesystem standing in for `node:fs` in the browser build.
//
// The engine's coupling to the filesystem is five functions wide — readdirSync,
// statSync, lstatSync, realpathSync, readFileSync — all of them in walk.ts.
// Everything downstream of scanRepo is already a pure function over in-memory
// data, so satisfying those five is the whole job. The writable half
// (writeFileSync/mkdirSync/rmSync) exists because memory.ts and edit.ts import
// it; backing it for real costs a few lines and keeps those modules working.
//
// TWO-PHASE MOUNTING is what makes the playground honest. A jsDelivr manifest
// gives path AND size for every file in a repo, which is enough to answer
// lstatSync — so the playground mounts the full tree with NO bytes, fetches
// only the .gitignore files, and runs the real walk(). The keep-list that comes
// back IS the download list. No ignore rule, no size cap and no `capped` flag
// is reimplemented in the UI; walk.ts decides, exactly as it does on disk.
//
// Deliberately NOT modelled: symlinks. Nothing in the mount path can create
// one (a manifest is a flat list of regular files), so isSymbolicLink() is
// always false and realpathSync is the identity on an existing path. walk's
// cycle and containment guards therefore hold trivially rather than vacuously.

import { normalize as normalizePath, dirname, basename } from "./path.js";

const ROOT = "/";

interface FileEntry {
  kind: "file";
  size: number;
  mtimeMs: number;
  bytes?: Uint8Array; // absent = mounted from a manifest, contents not fetched yet
}

interface DirEntry {
  kind: "dir";
  mtimeMs: number;
  children: Set<string>;
}

type Entry = FileEntry | DirEntry;

const entries = new Map<string, Entry>([[ROOT, { kind: "dir", mtimeMs: 0, children: new Set() }]]);

// Absolute, normalized, no trailing slash (except the root itself).
function key(path: string): string {
  const abs = path.startsWith("/") ? path : "/" + path;
  const norm = normalizePath(abs);
  return norm.length > 1 && norm.endsWith("/") ? norm.slice(0, -1) : norm;
}

function enoent(path: string, syscall: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  err.errno = -2;
  err.path = path;
  err.syscall = syscall;
  return err;
}

function enotdir(path: string, syscall: string): NodeJS.ErrnoException {
  const err = new Error(`ENOTDIR: not a directory, ${syscall} '${path}'`) as NodeJS.ErrnoException;
  err.code = "ENOTDIR";
  err.errno = -20;
  err.path = path;
  err.syscall = syscall;
  return err;
}

function ensureDir(path: string): DirEntry {
  const k = key(path);
  const existing = entries.get(k);
  if (existing) {
    if (existing.kind !== "dir") throw enotdir(path, "mkdir");
    return existing;
  }
  const dir: DirEntry = { kind: "dir", mtimeMs: 0, children: new Set() };
  entries.set(k, dir);
  if (k !== ROOT) {
    const parent = ensureDir(dirname(k));
    parent.children.add(basename(k));
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Mount API — used by the playground worker, not by the engine.

export interface MountedFile {
  /** Absolute path inside the VFS, e.g. "/repo/src/index.ts". */
  path: string;
  /** Byte length. From the manifest in phase A; must match the bytes in phase B. */
  size: number;
  /** Contents, when already known (phase B, or a .gitignore fetched in phase A). */
  bytes?: Uint8Array;
}

/** Drop everything. Called between two repos so nothing leaks across sessions. */
export function resetVfs(): void {
  entries.clear();
  entries.set(ROOT, { kind: "dir", mtimeMs: 0, children: new Set() });
}

/**
 * Phase A: mount a tree from a manifest. `size` alone satisfies lstatSync, so
 * walk() can run — and decide what is worth downloading — before a single
 * content byte is fetched.
 */
export function mountFiles(files: Iterable<MountedFile>): void {
  for (const f of files) {
    const k = key(f.path);
    ensureDir(dirname(k)).children.add(basename(k));
    entries.set(k, { kind: "file", size: f.size, mtimeMs: 0, bytes: f.bytes });
  }
}

/**
 * Phase B: attach the bytes of a file already present in the manifest. Keeps
 * the manifest's declared size authoritative for stat, but corrects it when the
 * two disagree so readText and the content hash see one consistent file.
 */
export function setFileBytes(path: string, bytes: Uint8Array): void {
  const k = key(path);
  const entry = entries.get(k);
  if (entry && entry.kind === "file") {
    entry.bytes = bytes;
    entry.size = bytes.byteLength;
    return;
  }
  mountFiles([{ path: k, size: bytes.byteLength, bytes }]);
}

/** True once the file's contents are actually resident (phase B done for it). */
export function hasFileBytes(path: string): boolean {
  const entry = entries.get(key(path));
  return !!entry && entry.kind === "file" && entry.bytes !== undefined;
}

/**
 * Drop every file still lacking contents, and return how many were dropped.
 *
 * This closes the two-phase mount. Phase A deliberately mounts MORE than will
 * be fetched — the whole manifest — so walk() can choose; phase B fetches the
 * chosen ones, plus whatever a cap allowed. Without this call the leftovers
 * would still be in the tree, and the scan's own walk would find them, read
 * them as "" and index a set of phantom empty files. Pruning makes the tree
 * contain exactly what was actually downloaded, so what gets indexed is what
 * was really read.
 */
export function pruneUnfetched(): number {
  let pruned = 0;
  for (const [path, entry] of [...entries]) {
    if (entry.kind !== "file" || entry.bytes !== undefined) continue;
    entries.delete(path);
    const parent = entries.get(dirname(path));
    if (parent && parent.kind === "dir") parent.children.delete(basename(path));
    pruned++;
  }
  return pruned;
}

/** Total resident bytes — what the worker reports as its memory footprint. */
export function residentBytes(): number {
  let total = 0;
  for (const entry of entries.values()) {
    if (entry.kind === "file" && entry.bytes) total += entry.bytes.byteLength;
  }
  return total;
}

// ---------------------------------------------------------------------------
// The `node:fs` surface.

export interface Dirent {
  name: string;
  parentPath: string;
  path: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

export interface Stats {
  size: number;
  mtimeMs: number;
  mtime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

const never = () => false;

function makeDirent(name: string, parent: string, kind: "file" | "dir"): Dirent {
  return {
    name,
    parentPath: parent,
    path: parent,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: never,
    isBlockDevice: never,
    isCharacterDevice: never,
    isFIFO: never,
    isSocket: never,
  };
}

function makeStats(entry: Entry): Stats {
  const size = entry.kind === "file" ? entry.size : 0;
  return {
    size,
    mtimeMs: entry.mtimeMs,
    mtime: new Date(entry.mtimeMs),
    isFile: () => entry.kind === "file",
    isDirectory: () => entry.kind === "dir",
    isSymbolicLink: never,
    isBlockDevice: never,
    isCharacterDevice: never,
    isFIFO: never,
    isSocket: never,
  };
}

export function existsSync(path: string): boolean {
  return entries.has(key(path));
}

export function statSync(path: string): Stats {
  const entry = entries.get(key(path));
  if (!entry) throw enoent(path, "stat");
  return makeStats(entry);
}

// No symlinks exist in this VFS, so lstat and stat are the same call — which is
// exactly the equivalence walk.ts already relies on for non-link dirents.
export const lstatSync = statSync;

export function realpathSync(path: string): string {
  const k = key(path);
  if (!entries.has(k)) throw enoent(path, "realpath");
  return k;
}

export function readdirSync(path: string): string[];
export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
export function readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | Dirent[] {
  const k = key(path);
  const entry = entries.get(k);
  if (!entry) throw enoent(path, "scandir");
  if (entry.kind !== "dir") throw enotdir(path, "scandir");
  const names = [...entry.children];
  if (!options?.withFileTypes) return names;
  return names.map((name) => {
    const child = entries.get(k === ROOT ? `/${name}` : `${k}/${name}`);
    return makeDirent(name, k, child?.kind === "dir" ? "dir" : "file");
  });
}

export function readFileSync(path: string): Buffer;
export function readFileSync(path: string, encoding: BufferEncoding | { encoding: BufferEncoding }): string;
export function readFileSync(path: string, encoding?: BufferEncoding | { encoding: BufferEncoding }): Buffer | string {
  const entry = entries.get(key(path));
  if (!entry) throw enoent(path, "open");
  if (entry.kind !== "file") {
    const err = new Error(`EISDIR: illegal operation on a directory, read`) as NodeJS.ErrnoException;
    err.code = "EISDIR";
    throw err;
  }
  // Mounted from a manifest but never fetched: report it as absent rather than
  // as an empty file, so readText's catch returns "" and no phantom empty file
  // ever reaches the index.
  if (!entry.bytes) throw enoent(path, "open");
  const buf = Buffer.from(entry.bytes);
  if (!encoding) return buf;
  return buf.toString(typeof encoding === "string" ? encoding : encoding.encoding);
}

export function writeFileSync(path: string, data: string | Uint8Array): void {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  setFileBytes(path, bytes);
}

export function mkdirSync(path: string, _options?: { recursive?: boolean }): string | undefined {
  ensureDir(path);
  return undefined;
}

export function mkdtempSync(prefix: string): string {
  // Deterministic: a counter, not a random suffix. Nothing in the browser build
  // races over temp dirs, and determinism is the house rule.
  const path = `${prefix}${tempCounter++}`;
  ensureDir(path);
  return path;
}
let tempCounter = 0;

export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
  const k = key(path);
  const entry = entries.get(k);
  if (!entry) {
    if (options?.force) return;
    throw enoent(path, "unlink");
  }
  if (entry.kind === "dir") {
    for (const child of [...entry.children]) rmSync(k === ROOT ? `/${child}` : `${k}/${child}`, options);
  }
  entries.delete(k);
  const parent = entries.get(dirname(k));
  if (parent && parent.kind === "dir") parent.children.delete(basename(k));
}

export function renameSync(from: string, to: string): void {
  const fromKey = key(from);
  const entry = entries.get(fromKey);
  if (!entry) throw enoent(from, "rename");
  const toKey = key(to);
  if (entry.kind === "dir") {
    ensureDir(toKey);
    for (const child of [...entry.children]) {
      renameSync(fromKey === ROOT ? `/${child}` : `${fromKey}/${child}`, toKey === ROOT ? `/${child}` : `${toKey}/${child}`);
    }
  } else {
    ensureDir(dirname(toKey)).children.add(basename(toKey));
    entries.set(toKey, entry);
  }
  rmSync(fromKey, { force: true });
}

export default {
  existsSync,
  statSync,
  lstatSync,
  realpathSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  renameSync,
};
