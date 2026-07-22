// Repo text search: ripgrep when it's on PATH (fast), a pure-JS scan over
// walk() otherwise (always available). Both backends return the SAME shape,
// sorted by (file, line) with the cap applied after sorting, so a consumer
// cannot tell which backend ran — asserted by the backend-parity test.
import { walk, readText, IGNORE_DIRS, LOCKFILES } from "./walk.js";
import { compileGlobs } from "./glob.js";
import { sh, have } from "./util.js";
import { byStr } from "./sort.js";

export interface SearchHit {
  file: string; // repo-relative posix path
  line: number; // 1-based
  text: string; // the matching line, trimmed of the trailing newline
}

export interface GrepOptions {
  globs?: string[]; // restrict to matching paths (repo-relative)
  maxHits?: number; // cap AFTER sorting (default 200)
  ignoreCase?: boolean;
  // Force the JS backend even when ripgrep is available (tests, determinism).
  noRipgrep?: boolean;
}

const DEFAULT_MAX_HITS = 200;

function sortHits(hits: SearchHit[]): SearchHit[] {
  return hits.sort((a, b) => byStr(a.file, b.file) || a.line - b.line);
}

function rgBackend(root: string, pattern: string, opts: GrepOptions): SearchHit[] | undefined {
  // Align ripgrep's universe with walk()'s: search hidden files (the walker
  // does), skip the same junk dirs/lockfiles, and apply the same size cap.
  // rg's own binary detection + .gitignore handling already match the walker.
  const args = ["--no-heading", "--line-number", "--color=never", "--no-messages", "--hidden", "--max-filesize", "1M"];
  for (const d of IGNORE_DIRS) args.push("--glob", `!**/${d}/**`);
  // Lockfiles match at any depth, case-insensitively (the walker lowercases).
  for (const l of LOCKFILES) args.push("--iglob", `!**/${l}`);
  args.push("--glob", "!*.min.js", "--glob", "!*.min.css", "--glob", "!*.map");
  if (opts.ignoreCase) args.push("--ignore-case");
  for (const g of opts.globs ?? []) args.push("--glob", g);
  args.push("--regexp", pattern, "./");
  const res = sh("rg", args, { cwd: root });
  // status 1 = no matches (fine); anything else (bad pattern, crash) → let the
  // JS backend give the authoritative answer instead of guessing.
  if (res.missing || (!res.ok && res.status !== 1)) return undefined;
  const hits: SearchHit[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    hits.push({ file: m[1]!.replace(/^\.\//, ""), line: Number(m[2]), text: m[3]! });
  }
  return hits;
}

function jsBackend(root: string, pattern: string, opts: GrepOptions): SearchHit[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.ignoreCase ? "i" : "");
  } catch {
    return [];
  }
  const filter = compileGlobs(opts.globs);
  const hits: SearchHit[] = [];
  for (const f of walk(root).files) {
    if (filter && !filter(f.rel)) continue;
    const content = readText(f.abs);
    if (!content) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) hits.push({ file: f.rel, line: i + 1, text: lines[i]! });
    }
  }
  return hits;
}

export function grepRepo(root: string, pattern: string, opts: GrepOptions = {}): SearchHit[] {
  const max = opts.maxHits ?? DEFAULT_MAX_HITS;
  let hits: SearchHit[] | undefined;
  if (!opts.noRipgrep && have("rg")) hits = rgBackend(root, pattern, opts);
  hits ??= jsBackend(root, pattern, opts);
  return sortHits(hits).slice(0, max);
}
