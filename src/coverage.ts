// What an answer about a name could not see, said next to the answer.
//
// An evaluation on large real repositories found two ways an index answers
// "nothing" or "this much" while the truth lies where it never looked:
//   * a file over --max-bytes is not indexed at all — typescript-go's 1.4 MB
//     checker.go, so `refs NewChecker` answered `{defs: []}` with exit 0;
//   * a file past the per-file call-site cap keeps only some of its sites —
//     vite's `callers resolveConfig` answered 56 of 68.
// Both are known to the scan (RepoScan.oversized, FileRecord.callsCapped), so
// an answer that may be missing something names the files and the flag that
// brings them in, instead of looking complete.
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { classify } from "./classify.js";
import { fileArgReadings } from "./patharg.js";
import type { RepoScan } from "./scan.js";

// An oversized file larger than this is not read to look for a name: a
// generated or vendored blob, not a declaration anyone navigates to.
const MAX_PROBE_BYTES = 32 * 1024 * 1024;

export interface Coverage {
  // Files that call the name but reached the per-file call-site cap.
  callCapped?: string[];
  // Files left out for size whose text names it.
  notIndexed?: { file: string; size: number }[];
  hint: string;
}

const wordMemo = new WeakMap<RepoScan, Map<string, { file: string; size: number }[]>>();

// The oversized source files whose text holds `name` as a whole word.
export function oversizedNaming(scan: RepoScan, name: string): { file: string; size: number }[] {
  if (!scan.oversized?.length || !/^[A-Za-z_$][\w$]*$/.test(name)) return [];
  let memo = wordMemo.get(scan);
  if (!memo) wordMemo.set(scan, (memo = new Map()));
  const known = memo.get(name);
  if (known) return known;
  const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
  const out: { file: string; size: number }[] = [];
  for (const o of scan.oversized) {
    if (o.size > MAX_PROBE_BYTES || classify(o.rel, extname(o.rel).toLowerCase()) !== "code") continue;
    let text: string;
    try {
      text = readFileSync(join(scan.root, o.rel), "utf8");
    } catch {
      continue;
    }
    if (word.test(text)) out.push({ file: o.rel, size: o.size });
  }
  memo.set(name, out);
  return out;
}

// What a `callers` or `refs` answer about `name` may be missing. `calls`: the
// answer counts call sites, so a capped file matters too.
export function coverageFor(scan: RepoScan, name: string, opts: { calls: boolean }): Coverage | undefined {
  const callCapped = opts.calls
    ? scan.files.filter((f) => f.callsCapped && f.calls?.some((c) => c.name === name)).map((f) => f.rel)
    : [];
  const notIndexed = oversizedNaming(scan, name);
  if (!callCapped.length && !notIndexed.length) return undefined;
  const hints: string[] = [];
  if (callCapped.length) {
    hints.push(`${callCapped.length} file(s) reached the per-file call-site cap, so some of their calls are missing; re-index with a higher --max-calls`);
  }
  if (notIndexed.length) hints.push(sizeHint(notIndexed, `name "${name}"`));
  return {
    ...(callCapped.length ? { callCapped } : {}),
    ...(notIndexed.length ? { notIndexed } : {}),
    hint: hints.join("; "),
  };
}

function sizeHint(files: { file: string; size: number }[], what: string): string {
  const largest = Math.max(...files.map((f) => f.size));
  return `${files.length} file(s) over --max-bytes ${what} but are not indexed (${files.map((f) => f.file).join(", ")}); re-index with --max-bytes ${largest}`;
}

// The sentence an error about an unknown symbol gains when an oversized file
// names it; "" otherwise.
export function notIndexedNote(scan: RepoScan, name: string): string {
  const files = oversizedNaming(scan, name);
  return files.length ? ` — ${sizeHint(files, `name "${name}"`)}` : "";
}

// Why a file argument is not in the index, when the scan knows: it was left
// out for size. Undefined otherwise (not found, ignored, out of scope).
export function notIndexedFile(scan: RepoScan, repo: string, arg: string): string | undefined {
  const readings = fileArgReadings(repo, arg);
  const hit = scan.oversized?.find((o) => readings.includes(o.rel));
  return hit
    ? `not in the index: ${hit.rel} is ${hit.size} bytes, over --max-bytes (default 1 MiB); re-index with --max-bytes ${hit.size} to include it`
    : undefined;
}
