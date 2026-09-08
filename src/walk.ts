import { readdirSync, statSync, lstatSync, readFileSync, realpathSync, existsSync, type Dirent } from "node:fs";
import { join, resolve, sep, extname } from "node:path";
import { parseGitignore, isIgnored, type IgnoreRule } from "./ignore.js";
import { readTextEx } from "./text.js";
export { readTextEx } from "./text.js";

// Directories that never carry signal for a documentation/code question and
// would bloat the index (dependencies, build output, VCS internals, caches).
// .codeindex is the engine's OWN output (index artifacts, pulled models, MCP
// memories) — indexing it would feed memories into search and churn the scan
// fingerprint on every write_memory (issue #12).
// Exported so grep.ts can align ripgrep's universe with the walker's.
export const IGNORE_DIRS = new Set([
  ".git", "node_modules", ".pnpm", "bower_components", "vendor", "dist", "build", "out",
  "target", ".next", ".nuxt", ".svelte-kit", ".turbo", "coverage", "__pycache__", ".venv",
  "venv", ".tox", ".mypy_cache", ".pytest_cache", ".gradle", ".idea", ".vscode", ".cache",
  "tmp", ".ultraindex", ".codeindex", "Pods", "DerivedData", ".terraform", "elm-stuff", ".dart_tool",
]);

// The VCS entry that marks a repository root: a directory for a normal clone,
// a "gitdir: <path>" FILE for a linked worktree or a submodule.
const GIT_ENTRY = ".git";

function isIgnoredDirectory(name: string, ignoreDirs: Set<string>): boolean {
  // `.git` is structural, not a preference: VCS internals (objects, packs,
  // hooks) never carry signal, so it stays ignored even when a caller-supplied
  // `ignoreDirs` replaces the default set without listing it — `--ignore-dir
  // foo` used to pull thousands of loose objects into the index.
  // A process killed during an atomic symbolic edit can leave the
  // `.codeindex-edit-*` directory beside the source. It contains a copy of that
  // source and must never become a duplicate phantom file in the next index,
  // even when the consumer repo has no matching .gitignore rule.
  return name === GIT_ENTRY || ignoreDirs.has(name) || name.startsWith(".codeindex-edit-");
}

// A gitfile's mandatory opening bytes. Git's parser (read_gitfile_gently)
// compares the first 8 bytes against exactly this — verified against real git:
// `gitdir:` without the space, leading whitespace, or the line appearing
// anywhere but the start are all rejected as "invalid gitfile format".
const GITFILE_PREFIX = "gitdir: ";
// A real gitfile is one short line. The cap keeps a file that merely CARRIES the
// name `.git` — a stray archive, a truncated dump — from being read whole just
// to discover it is not a gitfile.
const MAX_GITFILE_BYTES = 4096;

// The git directory a `.git` entry in `dir` points at, or undefined when there
// is none, or when the entry is not a repository marker.
//
// Why validity is checked instead of assumed: the boundary used to trigger on
// the NAME alone, so a file named `.git` holding anything else — a truncated
// write, an unrelated file carrying the name, a dangling symlink — silently
// dropped its whole subtree from the index. Silent truncation is the one
// failure this walk does not allow.
//
// A DIRECTORY named `.git` is the git dir. A FILE is a marker only when it
// opens with `gitdir: ` (above); the rest, trailing whitespace trimmed, is the
// path. Symlinks are followed — git supports a symlinked `.git`, and a link's
// dirent is neither file nor directory, so its target decides.
//
// DELIBERATE DEVIATION: git additionally requires the TARGET to look like a
// repository (HEAD, objects/, refs/) and reports "not a git repository" when it
// does not. This walk stops at a well-formed marker whatever its target, and
// the tests pin that: a stale gitfile left by a pruned or moved worktree still
// sits on a full checkout, and indexing it would duplicate the parent's sources
// — exactly what the boundary exists to prevent.
//
// The returned dir is the COMMON one where relevant: a linked worktree's git
// dir points at the shared common dir via its `commondir` file, and that is
// where git keeps `info/` for every worktree.
function gitDirOf(dir: string, entries: readonly Dirent[]): string | undefined {
  const marker = entries.find((e) => e.name === GIT_ENTRY);
  if (!marker) return undefined;
  const path = join(dir, GIT_ENTRY);
  try {
    if (marker.isDirectory()) return path; // a plain clone — decided on the dirent, no syscall
    const st = statSync(path); // a file, or a symlink resolved through its target
    if (st.isDirectory()) return path;
    if (!st.isFile() || st.size > MAX_GITFILE_BYTES) return undefined;
    const content = readFileSync(path, "utf8");
    if (!content.startsWith(GITFILE_PREFIX)) return undefined; // not a gitfile — not a marker
    // Only the line ending is stripped, never trailing spaces or tabs: git
    // trims exactly `\n` and `\r`, so a git directory whose name ENDS in a
    // space is reachable through a gitfile — verified against real git, which
    // accepts `gitdir: <dir >` and rejects the same path trimmed. Trimming
    // whitespace here silently resolved such a repo to the wrong directory,
    // and its `info/exclude` was then never found.
    const target = content.slice(GITFILE_PREFIX.length).replace(/[\r\n]+$/, "");
    if (!target) return undefined;
    const gitDir = resolve(dir, target);
    const common = join(gitDir, "commondir");
    return existsSync(common) ? resolve(gitDir, readFileSync(common, "utf8").trim()) : gitDir;
  } catch {
    return undefined;
  }
}

// This checkout's `info/exclude` — git's per-clone, never-committed ignore file
// (the walker honored only .gitignore, so local junk a developer excluded there
// was still indexed). Returns "" when absent or unreadable.
function readInfoExclude(gitDir: string | undefined): string {
  if (!gitDir) return "";
  try {
    const exclude = join(gitDir, "info", "exclude");
    return existsSync(exclude) ? readText(exclude) : "";
  } catch {
    return "";
  }
}

// Lockfiles: huge, machine-generated, and pure noise for a code/docs question —
// they'd otherwise rank as keyword-dense "code" hits (e.g. package-lock.json
// matching a dependency name). Skipped entirely.
export const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "composer.lock", "cargo.lock", "poetry.lock", "pipfile.lock", "gemfile.lock", "go.sum",
  "flake.lock", "packages.lock.json", "podfile.lock", "mix.lock",
]);

// Binary / non-source extensions to skip when reading file contents.
export const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns", ".svg", ".pdf", ".zip",
  ".gz", ".tar", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war", ".class", ".so", ".dylib",
  ".dll", ".exe", ".bin", ".o", ".a", ".wasm", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3",
  ".mp4", ".mov", ".avi", ".webm", ".wav", ".flac", ".ogg", ".lock", ".min.js", ".map",
]);

/** An observed exclusion. Directory contents are not enumerated. */
export interface WalkSkip {
  rel: string;
  reason: "binary-ext" | "lockfile" | "over-max-bytes" | "gitignored" | "minified" | "symlink-outside-root" | "broken-symlink" | "directory-symlink" | "ignore-dir" | "nested-repo" | "filter" | "unreadable";
  directory: boolean;
  size?: number;
}

export interface WalkEntry {
  rel: string;
  abs: string;
  directory: boolean;
}

export interface WalkOptions {
  maxFileBytes?: number; // skip files larger than this (default 1 MiB)
  maxFiles?: number; // hard cap on indexed files (default: none — see DEFAULT_MAX_FILES)
  // Honor .gitignore files (root and nested, with negation/anchoring/dir-only
  // semantics — see ignore.ts). Default TRUE: an ignored file is noise for
  // every consumer; pass false to index generated/ignored trees deliberately.
  gitignore?: boolean;
  // Directory names to skip, REPLACING the default set entirely (not merging
  // with it) — except `.git`, which is skipped whatever the list says.
  // IGNORE_DIRS is a public export, so consumers compose
  // `[...IGNORE_DIRS, "extra"]` — or filter it — themselves; replace is the
  // simplest contract. Deliberate scope boundary: grep.ts (the ripgrep
  // universe) and the MCP server keep the DEFAULT set — recall consumers
  // (e.g. ultrasec) consume scan/extract, not grep.
  ignoreDirs?: string[];
  /** Inventory modes opt in; source indexing retains its existing defaults. */
  includeLockfiles?: boolean;
  includeBinary?: boolean;
  includeOversize?: boolean;
  includeMinified?: boolean;
  /** Replace the binary extension policy, e.g. to retain textual SVG. */
  binaryExtensions?: ReadonlySet<string>;
  /** Called before entering a directory or accepting a file. False prunes it. */
  filter?: (entry: WalkEntry) => boolean;
  /** Observe exclusions without retaining a second inventory in memory. */
  onSkip?: (entry: WalkSkip) => void;
}

export interface WalkedFile {
  rel: string; // path relative to root, posix-style
  abs: string;
  size: number;
  ext: string;
  mtimeMs: number; // last-modified ms — the stat fastpath's freshness key with size
}

export interface WalkResult {
  files: WalkedFile[];
  capped: boolean; // true when the maxFiles cap was hit and the walk stopped early
  // Files that were SEEN and rejected by the size/lockfile/binary/minified/
  // gitignore rules, plus one per nested-repository boundary the walk stopped
  // at (a subdirectory carrying its own `.git`). Ignored DIRECTORIES
  // (node_modules, gitignored trees…) are not counted — their contents were
  // never even listed.
  excluded: number;
}

// The cap this walk USED to apply by default. Kept exported — it is part of the
// public surface and consumers pass it deliberately — but no longer the default:
// silently indexing 20,000 files of a 30,000-file monorepo answers questions
// about two thirds of a repo while looking like an answer about the repo. A
// caller that wants the old rail passes `maxFiles: DEFAULT_MAX_FILES`.
export const DEFAULT_MAX_FILES = 20_000;

// Recursively list source-like files under `root`, applying ignore rules. Pure
// filesystem walk — no git dependency, so it works on any directory. Returns a
// `capped` flag (never a silent truncation) so the caller can warn when a
// caller-supplied maxFiles cap stopped the walk with files still unindexed.
export function walk(root: string, opts: WalkOptions = {}): WalkResult {
  const maxFileBytes = opts.maxFileBytes ?? 1024 * 1024;
  // No cap unless the caller asks for one. `capped` therefore reports only a
  // limit the caller chose, never one the engine imposed behind their back.
  const maxFiles = opts.maxFiles ?? Infinity;
  const useGitignore = opts.gitignore !== false;
  // Effective ignored-directory set, built once: the caller's replacement when
  // given (see WalkOptions.ignoreDirs — replace, never merge), else the default.
  const ignoreDirs = opts.ignoreDirs ? new Set(opts.ignoreDirs) : IGNORE_DIRS;
  const out: WalkedFile[] = [];
  let capped = false;
  let excluded = 0;
  const skip = (rel: string, reason: WalkSkip["reason"], directory = false, size?: number): void => {
    opts.onSkip?.({ rel, reason, directory, ...(size === undefined ? {} : { size }) });
  };

  // Containment root for the symlink-escape guard: a symlinked file or
  // directory whose real path leaves the repo must not be indexed (it would
  // read foreign content and emit citations no one can open).
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { files: out, capped, excluded };
  }
  const contained = (real: string): boolean => real === rootReal || real.startsWith(rootReal + sep);

  // Each frame carries the ignore-rule chain inherited from its ancestors;
  // rules from deeper .gitignore files are appended after (later rules win).
  const stack: { dir: string; rel: string; rules: readonly IgnoreRule[] }[] = [
    { dir: root, rel: "", rules: [] },
  ];
  const seenDirs = new Set<string>(); // resolved real dirs already walked
  walking: while (stack.length) {
    const frame = stack.pop()!;
    // Cycle guard: a directory symlink pointing at an ancestor would otherwise
    // make walk() loop, flooding the index with phantom duplicate files. Resolve
    // the real path and skip any directory we've already descended into.
    let real: string;
    try {
      real = realpathSync(frame.dir);
    } catch {
      continue;
    }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    if (!contained(real)) continue; // dir symlink escaping the repo
    let entries: Dirent[];
    try {
      // Sorted so the walk order — and therefore WHICH files survive a
      // maxFiles cap — is identical across filesystems and machines. Dirents
      // sort by .name under the same code-unit comparison the bare-string
      // sort used, so the order is byte-identical to the previous readdir.
      entries = readdirSync(frame.dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      continue;
    }
    // Resolved at most once per directory, and only when a `.git` entry is
    // actually listed — so an ordinary directory costs one name comparison.
    const gitDir = entries.some((e) => e.name === GIT_ENTRY) ? gitDirOf(frame.dir, entries) : undefined;
    // Nested-repository boundary: a subdirectory that IS another repo — a
    // linked worktree under .claude/worktrees/, a vendored clone, a submodule.
    // Its files belong to THAT repo's index, and walking them here produced
    // thousands of phantom duplicates of the same sources (a repo with four
    // worktrees indexed five copies of itself); git itself never lists them.
    // Structural: independent of the gitignore layer.
    if (frame.rel && gitDir) {
      excluded++;
      skip(frame.rel, "nested-repo", true);
      continue;
    }
    let rules = frame.rules;
    if (useGitignore && !frame.rel) {
      // `.git/info/exclude` sits BEFORE every .gitignore in git's own
      // precedence (a .gitignore rule can still negate it — later rules win).
      const parsed = parseGitignore(readInfoExclude(gitDir), "");
      if (parsed.length) rules = [...rules, ...parsed];
    }
    if (useGitignore && entries.some((e) => e.name === ".gitignore")) {
      const parsed = parseGitignore(readText(join(frame.dir, ".gitignore")), frame.rel);
      if (parsed.length) rules = [...rules, ...parsed];
    }
    for (const entry of entries) {
      const name = entry.name;
      const abs = join(frame.dir, name);
      const rel = frame.rel ? `${frame.rel}/${name}` : name;
      // The dirent type IS the lstat type (Node lstats internally when the
      // filesystem can't supply it), so no lstat is needed to detect links.
      const isLink = entry.isSymbolicLink();
      // The root's own `.git` entry, whatever its type: the directory is VCS
      // internals, the gitfile of a linked worktree or submodule is a one-line
      // pointer — neither is source, and git lists neither.
      if (name === GIT_ENTRY) continue;
      // Ignored-directory boundary (node_modules, .git…): skip on the dirent
      // type alone — ZERO stat syscalls. A symlink reports isDirectory()
      // false on its dirent and falls through to the stat-based
      // classification below, so a link named node_modules still classifies
      // by its target exactly as before.
      if (entry.isDirectory() && isIgnoredDirectory(name, ignoreDirs)) {
        skip(rel, "ignore-dir", true);
        continue;
      }
      let st;
      try {
        // Non-links: a single lstatSync supplies isDirectory/isFile/size/
        // mtimeMs — field-for-field what the previous statSync returned,
        // since with no link to follow the two calls are identical. Links:
        // keep the following statSync so the entry classifies by its TARGET;
        // a broken link throws here and is skipped, same as before.
        st = isLink ? statSync(abs) : lstatSync(abs);
      } catch {
        skip(rel, isLink ? "broken-symlink" : "unreadable");
        continue;
      }
      if (st.isDirectory()) {
        if (isIgnoredDirectory(name, ignoreDirs)) { skip(rel, "ignore-dir", true); continue; }
        // An in-repo DIRECTORY symlink is skipped entirely: its target is (or
        // will be) walked under its canonical name, and letting both paths race
        // through the cycle guard would keep whichever readdir served first —
        // aliased, filesystem-order-dependent indexes. Out-of-repo links are
        // covered by the containment guard above.
        if (isLink) { skip(rel, "directory-symlink", true); continue; }
        if (useGitignore && rules.length && isIgnored(rules, rel, true)) { skip(rel, "gitignored", true); continue; }
        if (opts.filter && !opts.filter({ rel, abs, directory: true })) { skip(rel, "filter", true); continue; }
        stack.push({ dir: abs, rel, rules });
        continue;
      }
      if (!st.isFile()) continue;
      const ext = extname(name).toLowerCase();
      // Ignore first so inventory clients report the user's reason, even for
      // a file that would also fail the source-indexing size/extension policy.
      let reason: WalkSkip["reason"] | undefined;
      if (useGitignore && rules.length && isIgnored(rules, rel, false)) reason = "gitignored";
      else if (opts.filter && !opts.filter({ rel, abs, directory: false })) reason = "filter";
      else if (st.size > maxFileBytes && !opts.includeOversize) reason = "over-max-bytes";
      else if (LOCKFILES.has(name.toLowerCase()) && !opts.includeLockfiles) reason = "lockfile";
      else if ((opts.binaryExtensions ?? BINARY_EXT).has(ext) && !opts.includeBinary) reason = "binary-ext";
      else if ((name.endsWith(".min.js") || name.endsWith(".min.css")) && !opts.includeMinified) reason = "minified";
      if (reason) {
        excluded++;
        skip(rel, reason, false, st.size);
        continue;
      }
      // Symlink-escape guard for files (statSync above follows links).
      if (isLink) {
        try {
          if (!contained(realpathSync(abs))) { skip(rel, "symlink-outside-root"); continue; }
        } catch {
          skip(rel, "broken-symlink");
          continue;
        }
      }
      // The cap is enforced HERE, on kept files, so a flat directory cannot
      // silently overshoot it and `capped` is set exactly when a file was
      // actually dropped (never a silent truncation).
      if (out.length >= maxFiles) {
        capped = true;
        break walking;
      }
      out.push({ rel: rel.split(sep).join("/"), abs, size: st.size, ext, mtimeMs: st.mtimeMs });
    }
  }
  return { files: out, capped, excluded };
}

/** Compatibility reader; use readTextEx when empty, binary and unreadable differ. */
export function readText(abs: string): string {
  return readTextEx(abs).text;
}
