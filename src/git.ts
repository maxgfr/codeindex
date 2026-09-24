import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { byStr } from "./sort.js";
import { sh } from "./util.js";

// The short HEAD commit of a working tree, when it is a git repo. Recorded in
// the manifest so an index is pinned to an exact revision. Returns undefined
// when `git` is absent or the directory isn't a repo — the index still works.
export function headCommit(dir: string): string | undefined {
  const res = sh("git", ["-C", dir, "rev-parse", "--short", "HEAD"]);
  return res.ok ? res.stdout.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Every call whose output is PARSED pins the config that would change its
// bytes. A user's diff.noprefix / diff.mnemonicPrefix (a/ b/ become c/ w/ i/),
// diff.relative, log.showSignature (gpg chatter on stdout), log.follow (turns
// the single "." pathspec below into --follow) or log.showRoot=false (drops
// the root commit's files) would otherwise corrupt paths silently. Colour is
// switched off with --no-color on each command instead: color.diff=always
// outranks color.ui. core.quotePath=false keeps non-ASCII paths verbatim, -z
// (NUL separators) is used wherever a path can contain anything surprising,
// and the one parse that cannot use it (diffHunks) C-unquotes.
//
// Paths are relative to `dir`, not to the git toplevel: --repo may be one
// package of a monorepo, and the index keys files from --repo. Hence
// --relative on diffs; ls-files is cwd-relative already; readHistory strips
// the prefix itself.
const GIT_CONFIG = [
  "-c", "core.quotePath=false",
  "-c", "color.ui=false",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.relative=false",
  "-c", "log.showSignature=false",
  "-c", "log.follow=false",
  "-c", "log.showRoot=true",
];

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string; // renames only
  binary?: boolean;
  linesAdded?: number;
  linesDeleted?: number;
}

// A changed line range on the NEW side of the diff. A pure deletion has no new
// lines, so it maps to the touch-point line and is flagged approx.
export interface Hunk {
  start: number;
  end: number;
  approx?: boolean;
}

// The diff to take: a merge-base for branch review, or the staged changeset.
export interface DiffSpec {
  mergeBase?: string;
  staged?: boolean;
}

const gitArgs = (dir: string): string[] => ["-C", dir, ...GIT_CONFIG];
const rangeArgs = (spec: DiffSpec): string[] => (spec.staged ? ["--cached"] : [spec.mergeBase!]);

export function isGitWorktree(dir: string): boolean {
  return sh("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]).ok;
}

// Resolve the review base. An explicit ref must exist; otherwise the first of
// origin/HEAD → origin/main → origin/master → main → master that resolves is
// taken, and the comparison point is its MERGE-BASE with HEAD (PR semantics —
// commits landed on the base branch never count as yours). With no candidate
// (fresh repo, detached CI clone) the base falls back to HEAD with a note.
export function resolveBaseRef(
  dir: string,
  base?: string,
): { ref: string; mergeBase: string; note?: string } | { error: string } {
  const verify = (ref: string): boolean =>
    sh("git", [...gitArgs(dir), "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;
  const mergeBase = (ref: string): string | undefined => {
    const mb = sh("git", [...gitArgs(dir), "merge-base", ref, "HEAD"]);
    return mb.ok ? mb.stdout.trim() : undefined;
  };

  if (base) {
    if (!verify(base)) return { error: `base ref "${base}" not found (tried git rev-parse --verify)` };
    const mb = mergeBase(base);
    if (!mb) return { error: `no merge-base between "${base}" and HEAD` };
    return { ref: base, mergeBase: mb };
  }

  const originHead = sh("git", [...gitArgs(dir), "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const candidates = [
    ...(originHead.ok ? [originHead.stdout.trim().replace("refs/remotes/", "")] : []),
    "origin/main",
    "origin/master",
    "main",
    "master",
  ];
  for (const c of candidates) {
    if (!verify(c)) continue;
    const mb = mergeBase(c);
    if (mb) return { ref: c, mergeBase: mb };
  }
  const head = sh("git", [...gitArgs(dir), "rev-parse", "HEAD"]);
  if (!head.ok) return { error: "cannot resolve HEAD — empty repository?" };
  return {
    ref: "HEAD",
    mergeBase: head.stdout.trim(),
    note: "base: HEAD (no default branch found — reviewing uncommitted work)",
  };
}

// Changed files with statuses (rename-aware) plus per-file churn/binary info
// from --numstat. Default spec compares the merge-base against the WORKTREE —
// committed + staged + unstaged, "review my branch as it sits".
export function diffFiles(dir: string, spec: DiffSpec): DiffFile[] {
  const out: DiffFile[] = [];
  const ns = sh("git", [...gitArgs(dir), "diff", "--no-color", "--relative", "-z", "-M", "--name-status", ...rangeArgs(spec)]);
  if (ns.ok) {
    const toks = ns.stdout.split("\0");
    let i = 0;
    while (i < toks.length) {
      const st = toks[i++];
      if (!st) break;
      const code = st[0]!;
      if (code === "R" || code === "C") {
        const oldPath = toks[i++];
        const path = toks[i++];
        if (path) out.push({ path, status: "renamed", oldPath });
      } else {
        const path = toks[i++];
        if (!path) break;
        const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified"; // M/T/U fold into modified
        out.push({ path, status });
      }
    }
  }

  const byPath = new Map(out.map((f) => [f.path, f]));
  const num = sh("git", [...gitArgs(dir), "diff", "--no-color", "--relative", "-z", "-M", "--numstat", ...rangeArgs(spec)]);
  if (num.ok) {
    const toks = num.stdout.split("\0");
    let i = 0;
    while (i < toks.length) {
      const head = toks[i++];
      if (!head) break;
      const m = head.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/);
      if (!m) continue;
      let path = m[3]!;
      if (path === "") {
        i++; // rename record: skip the old-path token
        path = toks[i++] ?? "";
      }
      const rec = byPath.get(path);
      if (!rec) continue;
      if (m[1] === "-") rec.binary = true;
      else {
        rec.linesAdded = Number(m[1]);
        rec.linesDeleted = Number(m[2]);
      }
    }
  }
  return out;
}

// Changed NEW-side line ranges per file, from one --unified=0 diff call. Pure
// deletions map to their touch-point line, flagged approx. Files with no
// content hunks (pure renames, binaries) are absent. The patch is forced into
// the one shape parsed below: explicit a/ b/ prefixes, no external diff
// driver or textconv (their line numbers are not the file's), no inner
// submodule diffs, and no merging of nearby hunks (diff.interHunkContext).
export function diffHunks(dir: string, spec: DiffSpec): Map<string, Hunk[]> {
  const map = new Map<string, Hunk[]>();
  const res = sh("git", [
    ...gitArgs(dir),
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--submodule=short",
    "--relative",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "-M",
    "--unified=0",
    "--inter-hunk-context=0",
    ...rangeArgs(spec),
  ]);
  if (!res.ok) return map;
  let current: Hunk[] | undefined;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = newSidePath(line.slice(4));
      if (path === undefined) {
        current = undefined;
        continue;
      }
      current = map.get(path) ?? [];
      map.set(path, current);
    } else if (current && line.startsWith("@@")) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count === 0) current.push({ start: Math.max(start, 1), end: Math.max(start, 1), approx: true });
      else current.push({ start, end: start + count - 1 });
    }
  }
  return map;
}

// The path of a `+++ ` header: `b/<path>`, or `"b/<escaped path>"` when the
// path holds a quote, backslash or control character; /dev/null (undefined)
// for a deletion. git appends a TAB when the name contains a space — a hint
// for patch(1), not part of the name — so exactly one trailing TAB goes, and
// nothing is trimmed: a name may legitimately end in a space.
function newSidePath(header: string): string | undefined {
  let p = header.endsWith("\t") ? header.slice(0, -1) : header;
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = cUnquote(p);
  if (p === "/dev/null") return undefined;
  return p.startsWith("b/") ? p.slice(2) : p;
}

// Undo git's C-style quoting: \" \\ \t \n … plus \ooo octal escapes. The
// escapes stand for BYTES — a multibyte character arrives as several \ooo —
// so decoding works on the UTF-8 bytes and reassembles the string at the end.
// A backslash byte (0x5c) never occurs inside a UTF-8 multibyte sequence.
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
function cUnquote(quoted: string): string {
  const src = Buffer.from(quoted.slice(1, -1), "utf8");
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const b = src[i]!;
    if (b !== 0x5c || i + 1 >= src.length) {
      out.push(b);
      continue;
    }
    const e = src[++i]!;
    if (e >= 0x30 && e <= 0x37) {
      out.push(parseInt(src.toString("latin1", i, i + 3), 8) & 0xff);
      i += 2;
    } else {
      out.push(C_ESCAPES[String.fromCharCode(e)] ?? e); // \" and \\ stand for themselves
    }
  }
  return Buffer.from(out).toString("utf8");
}

// Untracked (but not ignored) files — part of "the branch as it sits".
export function untrackedFiles(dir: string): string[] {
  const res = sh("git", [...gitArgs(dir), "ls-files", "--others", "--exclude-standard", "-z"]);
  if (!res.ok) return [];
  return res.stdout.split("\0").filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// History mining for churn, hotspots, risk and coupling: ONE `git log` pass,
// parsed into per-commit lists of interned path ids that every consumer
// shares (and that is memoized per HEAD, below).

// A parsed `git log --name-only` window. Paths are toplevel-relative and
// interned, so consumers count with integer keys; repoPaths() projects them
// onto --repo. Shared through the memo: read-only for consumers.
export interface CommitLog {
  prefix: string; // --repo relative to the git toplevel: "" at the root, else "pkg/app/"
  paths: string[]; // id → toplevel-relative path
  starts: number[]; // commit c touched ids[starts[c] .. starts[c + 1]); length = commits + 1
  ids: number[];
  // A shallow clone: history stops at the graft boundary, so every count is a
  // lower bound. The boundary commits themselves are left out — git diffs a
  // grafted commit against the EMPTY tree, so it would "change" every file it
  // contains (a depth-1 clone reported churn 1 for every file).
  shallow: boolean;
}

export type HistoryResult = { ok: true; log: CommitLog } | { ok: false; error: string };

// The raw log is read as a Buffer, not a string: a long history's name list
// runs to hundreds of MB (26k commits × 25 files is already 73 MB), past both
// sh()'s 64 MiB buffer — where it used to fail as a silent "no git" — and what
// one JS string should hold. Past this cap the error says so.
const LOG_MAX_BYTES = 1024 * 1024 * 1024;

// `since` is a commit-ish (count the commits after it) or a date. git's own
// date parser accepts anything — a typo'd ref parses as "now" and silently
// yields an empty window — so a date must look like one: ISO, optionally with
// a time, or "<n> <unit>s [ago]" spans ("6 months ago", "2.weeks.ago").
const SINCE_DATE =
  /^(?:\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?:Z|[+-]\d{2}:?\d{2})?|(?:\d+[ .](?:second|minute|hour|day|week|month|year)s?[ .]*)+(?:ago)?)$/i;

// In-process memo keyed by everything a log depends on: the directory, HEAD's
// full sha (content-addressed: same sha, same reachable history), the
// resolved window and the shallow boundary. An MCP session asking for
// onboard, hotspots and risk in a row pays one `git log`, not three; a new
// commit, fetch --deepen or a moved ref changes the key. LRU-bounded: one
// server may serve several repositories.
const LOG_MEMO = new Map<string, CommitLog>();
const LOG_MEMO_MAX = 4;

export function readHistory(dir: string, since?: string): HistoryResult {
  // One rev-parse answers three questions: where --repo sits under the
  // toplevel, where this worktree's shallow file lives, and HEAD's sha. Exit
  // 128 = not a repository; exit 1 = no HEAD yet (an empty repository).
  const probe = sh("git", [...gitArgs(dir), "rev-parse", "--show-prefix", "--git-path", "shallow", "--verify", "--quiet", "HEAD"]);
  if (probe.missing) return { ok: false, error: "git was not found on PATH" };
  if (!probe.ok) {
    const error = probe.status === 1 ? "no commits yet (empty repository)" : firstLine(probe.stderr) || "not a git repository";
    return { ok: false, error };
  }
  const [prefix = "", shallowFile = "", head = ""] = probe.stdout.split("\n");
  const window = resolveWindow(dir, since);
  const boundary = shallowBoundary(resolve(dir, shallowFile));
  const revs = [head, ...window.exclude, ...boundary.map((sha) => `^${sha}`)];
  const key = JSON.stringify([resolve(dir), revs, window.args]);
  const hit = LOG_MEMO.get(key);
  if (hit) {
    LOG_MEMO.delete(key); // refresh its LRU position
    LOG_MEMO.set(key, hit);
    return { ok: true, log: hit };
  }

  // --no-renames: counting per path needs no rename pairing, and detection is
  // the expensive part — on a blobless partial clone it lazily FETCHES blobs
  // (20.7 s vs 0.2 s on werkzeug). Revisions arrive on stdin, so a long
  // shallow boundary cannot overflow the command line.
  const args = [...gitArgs(dir), "log", "--no-color", "--no-renames", ...window.args, "--pretty=format:%x1e", "--name-only", "-z", "--stdin"];
  // Below the toplevel only commits touching --repo matter, each with ALL its
  // files (--full-diff): coupling's mass-refactor cut is about the whole
  // commit. --full-history keeps side-branch commits that default history
  // simplification hides behind a merge TREESAME to one parent.
  if (prefix) args.push("--full-history", "--full-diff", "--", ".");
  const res = spawnSync("git", args, { input: revs.join("\n") + "\n", maxBuffer: LOG_MAX_BYTES, timeout: 600_000 });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    const error =
      code === "ENOBUFS"
        ? `git log output exceeds ${LOG_MAX_BYTES / 1024 / 1024} MiB — bound the window with since`
        : code === "ENOENT"
          ? "git was not found on PATH"
          : res.error.message;
    return { ok: false, error };
  }
  if (res.status !== 0) return { ok: false, error: firstLine(String(res.stderr ?? "")) || `git log exited with ${res.status}` };

  const log = parseLog(res.stdout, prefix, boundary.length > 0);
  LOG_MEMO.set(key, log);
  if (LOG_MEMO.size > LOG_MEMO_MAX) LOG_MEMO.delete(LOG_MEMO.keys().next().value!);
  return { ok: true, log };
}

function resolveWindow(dir: string, since: string | undefined): { exclude: string[]; args: string[] } {
  if (!since) return { exclude: [], args: [] };
  // A ref wins over a date reading of the same text (a tag named 2024-01-01).
  const ref = sh("git", [...gitArgs(dir), "rev-parse", "--verify", "--quiet", `${since}^{commit}`]);
  if (ref.ok) return { exclude: [`^${ref.stdout.trim()}`], args: [] };
  if (SINCE_DATE.test(since.trim())) {
    // Resolved to the timestamp git itself would use, so the memo key moves
    // with a relative date ("6 months ago" is a different window tomorrow).
    const date = sh("git", [...gitArgs(dir), "rev-parse", `--since=${since}`]);
    const m = /^--max-age=(\d+)$/m.exec(date.stdout);
    if (date.ok && m) return { exclude: [], args: [`--max-age=${m[1]}`] };
  }
  throw new Error(`since "${since}" is neither a commit (tag, branch, sha) nor a date (2024-01-01, "6 months ago")`);
}

function shallowBoundary(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).sort(byStr);
  } catch {
    return []; // no shallow file: complete history
  }
}

// `--pretty=format:%x1e --name-only -z`: each commit opens with RS (0x1e),
// then — when it lists files — "\n" and NUL-terminated paths; one more NUL
// separates commits. A merge lists nothing (no -m). NUL never occurs inside a
// UTF-8 sequence, so each path decodes on its own.
function parseLog(buf: Buffer, prefix: string, shallow: boolean): CommitLog {
  const idOf = new Map<string, number>();
  const paths: string[] = [];
  const starts: number[] = [];
  const ids: number[] = [];
  for (let pos = 0; pos < buf.length; ) {
    let end = buf.indexOf(0, pos);
    if (end < 0) end = buf.length;
    let s = pos;
    if (buf[s] === 0x1e) {
      starts.push(ids.length);
      s++;
      if (buf[s] === 0x0a) s++;
    }
    if (end > s && starts.length) {
      const path = buf.toString("utf8", s, end);
      let id = idOf.get(path);
      if (id === undefined) {
        id = paths.length;
        paths.push(path);
        idOf.set(path, id);
      }
      ids.push(id);
    }
    pos = end + 1;
  }
  starts.push(ids.length);
  return { prefix, paths, starts, ids, shallow };
}

// id → path relative to --repo, or undefined for a file outside it.
export function repoPaths(log: CommitLog): (string | undefined)[] {
  if (!log.prefix) return log.paths;
  const n = log.prefix.length;
  return log.paths.map((p) => (p.startsWith(log.prefix) ? p.slice(n) : undefined));
}

export interface ChurnResult {
  churn: Map<string, number>;
  // false when git is missing, the dir is not a repository or it has no
  // commit yet — `error` says which. Degrade loudly (callers say "no churn
  // data"), never with an empty map that reads as "nothing ever changed".
  ok: boolean;
  error?: string;
  shallow?: boolean; // see CommitLog.shallow: counts are lower bounds
  commits: number; // commits in the window that touched --repo
}

// Per-file commit counts over the whole history (or a `since` window: a ref,
// or a date) — the churn half of hotspot analysis. Keys are relative to
// `dir`, like the index's. A `since` that is neither a ref nor a date throws:
// an empty answer would read as "nothing changed".
export function gitChurn(dir: string, opts: { since?: string } = {}): ChurnResult {
  const churn = new Map<string, number>();
  const res = readHistory(dir, opts.since);
  if (!res.ok) return { churn, ok: false, error: res.error, commits: 0 };
  const { log } = res;
  const rel = repoPaths(log);
  const seen = new Int32Array(log.paths.length).fill(-1); // dedupe within a commit
  let commits = 0;
  for (let c = 0; c + 1 < log.starts.length; c++) {
    let touched = false;
    for (let k = log.starts[c]!; k < log.starts[c + 1]!; k++) {
      const id = log.ids[k]!;
      const path = rel[id];
      if (path === undefined || seen[id] === c) continue;
      seen[id] = c;
      touched = true;
      churn.set(path, (churn.get(path) ?? 0) + 1);
    }
    if (touched) commits++;
  }
  return { churn, ok: true, ...(log.shallow ? { shallow: true } : {}), commits };
}

// What a history-derived answer must say about the history it read, so a
// reader can tell "nothing changed" from "could not look" (error) and from
// "looked at a truncated clone" (shallow). Spread into churn, hotspots, risk
// and coupling output; empty for a complete, readable history.
export function historyStatus(res: { error?: string; shallow?: boolean }): { error?: string; shallow?: true; note?: string } {
  return {
    ...(res.error ? { error: res.error } : {}),
    ...(res.shallow
      ? { shallow: true as const, note: "shallow clone: history stops at the clone depth, so counts are lower bounds (git fetch --unshallow for all of it)" }
      : {}),
  };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]!.replace(/^fatal: /, "").trim();
}

// Files changed since a ref (worktree vs ref) plus untracked files — "what did
// I touch". Returns an empty set outside a git repo.
export function changedSince(dir: string, ref: string): Set<string> {
  const out = new Set<string>();
  const diff = sh("git", [...gitArgs(dir), "diff", "--no-color", "--relative", "-z", "--name-only", ref, "--"]);
  if (diff.ok) for (const p of diff.stdout.split("\0")) if (p) out.add(p);
  for (const p of untrackedFiles(dir)) out.add(p);
  return out;
}
