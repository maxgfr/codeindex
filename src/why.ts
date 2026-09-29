// `codeindex scan --why <path>` and `scan --skipped`: why a path is, or is not,
// in the index.
//
// The walk knows why it leaves every path out (WalkSkip), and nothing showed
// it: a 1.2 MiB checker.go silently absent (so editing it never changed the
// index), files outside a --scope, a gitignore rule nobody remembered. Each
// took a library script to diagnose. Both answers come from the scan's own walk
// with its skip reporting on, so they cannot drift from what the scan does.
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { classify } from "./classify.js";
import { extToLang } from "./lang/registry.js";
import { explainPathFilter, keptWalkedFiles, normalizeScope, type ScanOptions, type ScanSkip } from "./scan.js";
import type { WalkedFile } from "./walk.js";
import { byKey, byStr } from "./sort.js";

const DEFAULT_MAX_BYTES = 1024 * 1024; // walk.ts's maxFileBytes default

export type PathVerdictReason =
  | ScanSkip["reason"]
  | "outside-repo"
  | "not-found"
  | "max-files" // the walk stopped at --max-files before reaching it
  | "no-indexed-files" // a directory the walk entered, none of whose files it kept
  | "not-walked"; // anything else the walk passes over: a FIFO, an unlistable directory

export interface PathVerdict {
  path: string; // repo-relative ("." for the root); as given when outside the repo
  indexed: boolean;
  reason: PathVerdictReason | null; // null when indexed
  detail: Record<string, unknown>;
}

// Every path a scan with these options leaves out, sorted by path, and the
// files it keeps. A skipped directory is ONE entry: the walk never lists it.
export function scanSkips(root: string, opts: ScanOptions = {}): { skips: ScanSkip[]; files: WalkedFile[]; capped: boolean } {
  const skips: ScanSkip[] = [];
  const { files, capped } = keptWalkedFiles(root, { ...opts, precomputedWalk: undefined, onSkip: (s) => skips.push(s) });
  return { skips: skips.sort(byKey((s) => s.rel)), files, capped };
}

// Skips per reason, keys sorted.
export function skipHistogram(skips: readonly ScanSkip[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const s of skips) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const out: Record<string, number> = {};
  for (const reason of [...counts.keys()].sort(byStr)) out[reason] = counts.get(reason)!;
  return out;
}

// `path` is repo-relative or absolute, spelled as --scope accepts it.
export function whyPath(root: string, path: string, opts: ScanOptions = {}): PathVerdict {
  const rel = normalizeScope(root, path);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return { path, indexed: false, reason: "outside-repo", detail: {} };
  const shown = rel || ".";
  const { skips, files, capped } = scanSkips(root, opts);
  const kept = files.find((f) => f.rel === rel);
  if (kept) {
    return { path: shown, indexed: true, reason: null, detail: { kind: classify(kept.rel, kept.ext), lang: extToLang(kept.ext), size: kept.size } };
  }
  let st: Stats;
  try {
    st = lstatSync(join(root, rel)); // lstat: a broken link exists, as a link
  } catch {
    return { path: shown, indexed: false, reason: "not-found", detail: {} };
  }
  // The path itself, else the nearest directory above it the walk skipped:
  // nothing under a skipped directory is ever listed, so that skip is the answer.
  const byRel = new Map(skips.map((s) => [s.rel, s]));
  for (let at = rel; at; at = at.slice(0, Math.max(0, at.lastIndexOf("/")))) {
    const skip = byRel.get(at);
    if (skip) {
      const detail = { ...(at === rel ? {} : { dir: at }), ...skipDetail(root, opts, rel, skip) };
      return { path: shown, indexed: false, reason: skip.reason, detail };
    }
  }
  // The root's own `.git` is passed over without a skip (it is never source).
  if (rel === ".git" || rel.startsWith(".git/")) return { path: shown, indexed: false, reason: "ignore-dir", detail: { dir: ".git" } };
  if (st.isDirectory()) {
    const prefix = rel ? `${rel}/` : "";
    const count = files.filter((f) => f.rel.startsWith(prefix)).length;
    const skipped = skipHistogram(skips.filter((s) => s.rel.startsWith(prefix)));
    return { path: shown, indexed: count > 0, reason: count > 0 ? null : "no-indexed-files", detail: { directory: true, files: count, skipped } };
  }
  if (capped) return { path: shown, indexed: false, reason: "max-files", detail: { maxFiles: opts.maxFiles } };
  return { path: shown, indexed: false, reason: "not-walked", detail: {} };
}

// What decided a skip, beyond its reason. `rel` is the path asked about, which
// lies at or under `skip.rel`.
function skipDetail(root: string, opts: ScanOptions, rel: string, skip: ScanSkip): Record<string, unknown> {
  switch (skip.reason) {
    case "gitignored":
      return skip.rule ? { ...skip.rule } : {};
    case "over-max-bytes":
      return { size: skip.size, maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES };
    case "filter":
      return explainPathFilter(root, opts, rel) ?? {};
    case "binary-ext":
      return { ext: extname(skip.rel).toLowerCase() };
    case "index-output":
      return { out: opts.out };
    case "file-symlink":
    case "directory-symlink":
    case "symlink-outside-root":
      // What the link resolves to: repo-relative when it stays inside (the
      // path the target is indexed under), absolute when it leaves.
      try {
        const target = realpathSync(join(root, skip.rel));
        const inside = relative(realpathSync(root), target);
        return { target: inside.startsWith("..") || isAbsolute(inside) ? target : inside.split(sep).join("/") };
      } catch {
        return {};
      }
    default:
      return {};
  }
}
