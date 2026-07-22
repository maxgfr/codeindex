// Repo text search: ripgrep when it's on PATH (fast), a pure-JS scan over
// walk() otherwise (always available). Both backends return the SAME shape,
// sorted by (file, line) with the cap applied after sorting, so a consumer
// cannot tell which backend ran — asserted by the backend-parity test.
import { walk, readText, IGNORE_DIRS, LOCKFILES, BINARY_EXT } from "./walk.js";
import { compileGlobFilter } from "./glob.js";
import { sh, have } from "./util.js";
import { byStr } from "./sort.js";

export interface SearchHit {
  file: string; // repo-relative posix path
  line: number; // 1-based
  text: string; // the matching line, trimmed of the trailing newline
}

export interface GrepOptions {
  // Restrict to matching paths (repo-relative, rooted dialect). A `!` prefix
  // NEGATES the glob: `!sub/**` excludes that tree; exclusion beats inclusion
  // regardless of list order, identically on both backends.
  globs?: string[];
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
  // Align ripgrep's universe with walk()'s exactly: search hidden files (the
  // walker does), honor .gitignore even outside a git worktree, but NOT the
  // user/global/exclude/parent/.ignore layers the walker never reads; skip the
  // same junk dirs, lockfiles and binary extensions; same 1 MiB size cap.
  const args = [
    "--no-heading",
    "--line-number",
    "--null", // path\0line:text — a `:12:` inside a filename can't corrupt parsing
    "--color=never",
    "--no-messages",
    "--hidden",
    "--no-require-git",
    "--no-ignore-global",
    "--no-ignore-exclude",
    "--no-ignore-parent",
    "--no-ignore-dot",
    "--max-filesize",
    "1M",
  ];
  for (const d of IGNORE_DIRS) args.push("--glob", `!**/${d}/**`);
  // Lockfiles match at any depth, case-insensitively (the walker lowercases).
  for (const l of LOCKFILES) args.push("--iglob", `!**/${l}`);
  for (const ext of BINARY_EXT) args.push("--iglob", `!**/*${ext}`);
  args.push("--glob", "!*.min.js", "--glob", "!*.min.css");
  if (opts.ignoreCase) args.push("--ignore-case");
  // User globs use the engine's rooted dialect (compileGlobFilter anchors at
  // the repo root); a leading `/` makes rg anchor the same way instead of
  // basename-matching slash-less patterns. Positives go first and `!`-negated
  // globs LAST: rg resolves overlapping globs by last-match-wins, so this
  // ordering makes exclusion beat inclusion — the JS backend's semantics —
  // regardless of how the caller ordered the list.
  const user = opts.globs ?? [];
  const anchor = (g: string): string => (g.startsWith("/") ? g : `/${g}`);
  for (const g of user.filter((g) => !g.startsWith("!"))) args.push("--glob", anchor(g));
  for (const g of user.filter((g) => g.startsWith("!"))) args.push("--glob", `!${anchor(g.slice(1))}`);
  args.push("--regexp", pattern, "./");
  const res = sh("rg", args, { cwd: root });
  // status 1 = no matches (fine); anything else (crash, unsupported flag on an
  // old rg) → let the JS backend give the authoritative answer instead.
  if (res.missing || (!res.ok && res.status !== 1)) return undefined;
  const hits: SearchHit[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const nul = line.indexOf("\0");
    if (nul === -1) continue;
    const file = line.slice(0, nul).replace(/^\.\//, "");
    const rest = line.slice(nul + 1);
    const colon = rest.indexOf(":");
    if (colon === -1) continue;
    hits.push({ file, line: Number(rest.slice(0, colon)), text: rest.slice(colon + 1) });
  }
  return hits;
}

function jsBackend(root: string, re: RegExp, opts: GrepOptions): SearchHit[] {
  // Accept the same optionally-`/`-anchored spelling the rg path takes (the
  // anchor may follow the `!` of a negated glob: `!/sub/**` ≡ `!sub/**`).
  const filter = compileGlobFilter(opts.globs?.map((g) => g.replace(/^(!?)\//, "$1")));
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
  // The pattern dialect is JS RegExp on BOTH backends: validate up front and
  // throw the same error regardless of which backend runs, instead of one
  // backend silently returning [] on syntax the other accepts.
  const re = new RegExp(pattern, opts.ignoreCase ? "i" : "");
  const max = opts.maxHits ?? DEFAULT_MAX_HITS;
  let hits: SearchHit[] | undefined;
  if (!opts.noRipgrep && have("rg")) hits = rgBackend(root, pattern, opts);
  hits ??= jsBackend(root, re, opts);
  return sortHits(hits).slice(0, max);
}
