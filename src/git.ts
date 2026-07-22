import { sh } from "./util.js";

// The short HEAD commit of a working tree, when it is a git repo. Recorded in
// the manifest so an index is pinned to an exact revision. Returns undefined
// when `git` is absent or the directory isn't a repo — the index still works.
export function headCommit(dir: string): string | undefined {
  const res = sh("git", ["-C", dir, "rev-parse", "--short", "HEAD"]);
  return res.ok ? res.stdout.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Diff plumbing for `delta`. All calls disable core.quotePath so non-ASCII
// paths come back verbatim, and use -z (NUL separators) wherever a path could
// contain anything surprising.

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

const gitArgs = (dir: string): string[] => ["-C", dir, "-c", "core.quotePath=false"];
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
  const ns = sh("git", [...gitArgs(dir), "diff", "-z", "-M", "--name-status", ...rangeArgs(spec)]);
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
  const num = sh("git", [...gitArgs(dir), "diff", "-z", "-M", "--numstat", ...rangeArgs(spec)]);
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
// content hunks (pure renames, binaries) are absent.
export function diffHunks(dir: string, spec: DiffSpec): Map<string, Hunk[]> {
  const map = new Map<string, Hunk[]>();
  const res = sh("git", [...gitArgs(dir), "diff", "-M", "--unified=0", ...rangeArgs(spec)]);
  if (!res.ok) return map;
  let current: Hunk[] | undefined;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p === "/dev/null") {
        current = undefined;
        continue;
      }
      const path = p.startsWith("b/") ? p.slice(2) : p;
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

// Untracked (but not ignored) files — part of "the branch as it sits".
export function untrackedFiles(dir: string): string[] {
  const res = sh("git", [...gitArgs(dir), "ls-files", "--others", "--exclude-standard", "-z"]);
  if (!res.ok) return [];
  return res.stdout.split("\0").filter((p) => p.length > 0);
}
