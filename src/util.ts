import { spawnSync } from "node:child_process";

// Result of a subprocess call. `ok` is true on exit code 0 with the binary
// found; `missing` is true when the binary isn't on PATH (so callers can fall
// back gracefully instead of crashing — e.g. no ripgrep, no gh, no docker).
export interface ShResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}

// Run a command synchronously. Sync keeps the CLI simple and deterministic
// (mirrors how the engine is structured); the work is I/O-bound git/rg/gh calls
// where parallelism buys little. `input` feeds stdin; `maxBuffer` is generous
// for large `rg --json` / `git log` output.
export function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): ShResult {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: opts.env ?? process.env,
  });
  const missing = !!res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT";
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
    missing,
  };
}

// Is a binary available on PATH? Cached because we probe the same few tools
// (rg, gh, git, docker) repeatedly within a run.
const whichCache = new Map<string, boolean>();
export function have(cmd: string): boolean {
  const cached = whichCache.get(cmd);
  if (cached !== undefined) return cached;
  const probe = sh(process.platform === "win32" ? "where" : "which", [cmd]);
  const found = probe.ok && probe.stdout.trim().length > 0;
  whichCache.set(cmd, found);
  return found;
}

// Turn an arbitrary repo identifier into a filesystem-safe cache slug, e.g.
// "github.com/expressjs/express" -> "github.com-expressjs-express".
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

// Truncate a string to a max length with an ellipsis marker, for snippets.
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`;
}

// Truncate a string for INLINE display (a single line): collapse whitespace, cut
// at a word boundary, and never leave a dangling inline-code backtick — so a
// clipped module summary like "… in `path/` (typescript)" stays valid markdown
// instead of the broken "… in `path/` (types" a raw slice produces.
export function clipInline(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max).replace(/\s+\S*$/, ""); // back off to a word boundary
  if (!cut) cut = flat.slice(0, max); // a single token longer than max — hard cut
  // A half-open inline-code span: drop the severed backtick (and its partial
  // contents) rather than appending one, which would emit an empty `` span.
  if ((cut.match(/`/g)?.length ?? 0) % 2 === 1) cut = cut.replace(/`[^`]*$/, "");
  // A half-open markdown link `[text…`: drop from the unmatched `[`.
  if (cut.lastIndexOf("[") > cut.lastIndexOf("]")) cut = cut.slice(0, cut.lastIndexOf("["));
  return cut.replace(/\s+$/, "") + "…";
}

// Escape a string for safe inclusion as a literal inside a RegExp.
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pull the meaningful keywords out of a natural-language question: lowercase,
// split on non-word chars, drop stopwords and very short tokens, dedupe. Used
// to drive lexical search and symbol ranking deterministically (no LLM).
const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","do","does","did","how","what",
  "why","when","where","which","who","whom","this","that","these","those","of","in","on","to",
  "for","with","and","or","but","if","then","else","than","as","at","by","from","into","about",
  "it","its","i","you","we","they","he","she","there","here","can","could","should","would",
  "will","shall","may","might","must","have","has","had","not","no","yes","so","such","only",
  "any","some","all","get","set","use","used","using","work","works","working","handle","handled",
  "happen","happens","default","value","values","please","explain","tell","me","my","our",
]);

// Fold diacritics to their base letters (NFKD decomposition, then drop the
// combining marks in the U+0300–U+036F block) so "café" and "cafe" tokenize
// alike. Query and haystack must both pass through this so the two sides agree.
export function foldText(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

export function keywords(question: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of foldText(question).split(/[^A-Za-z0-9_]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    // Keep identifiers as-is (camelCase/snake_case often carry the real signal),
    // but filter generic English stopwords and 1-char noise.
    if (raw.length < 2) continue;
    if (STOPWORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(raw);
  }
  return out;
}

// Keywords ordered by how *distinctive* they are, most-specific first. Numbers
// (status codes like 429), camelCase/snake_case identifiers, and long tokens
// carry more signal than short generic words. Narrow search APIs (GitHub/GitLab
// issue search, StackOverflow) AND their terms, so feeding them the few most
// specific keywords — rather than the first N — dramatically improves recall.
export function rankedKeywords(question: string): string[] {
  const base = keywords(question);
  const score = (raw: string): number => {
    let s = 0;
    if (/\d/.test(raw)) s += 3;
    if (/[A-Z]/.test(raw) && !/^[A-Z0-9]+$/.test(raw)) s += 2; // camelCase/PascalCase
    if (/_/.test(raw)) s += 2;
    if (raw.length >= 8) s += 1.5;
    else if (raw.length >= 5) s += 0.5;
    return s;
  };
  return base
    .map((k, i) => ({ k, s: score(k), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.k);
}

// Reciprocal Rank Fusion: merge several ranked lists into one robust ranking
// without needing comparable scores across lists. `k` damps the contribution of
// low ranks. Returns keys ordered best-first with a fused score.
export function rrf<T>(
  lists: T[][],
  keyOf: (item: T) => string,
  k = 60,
): Map<string, number> {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, idx) => {
      const key = keyOf(item);
      score.set(key, (score.get(key) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return score;
}
