import { escapeRegExp } from "./util.js";

// Minimal glob → RegExp for --include/--exclude. Supports `**` (any path,
// crossing `/`), `*` (any run within a segment), and `?` (one non-`/` char).
// Patterns match against the posix path relative to the repo root. Anything
// fancier (brace expansion, extglob) is intentionally out of scope — keep it
// dependency-free and predictable.
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` — match across directory separators.
        i++;
        if (glob[i + 1] === "/") {
          // `a/**/b` should also match `a/b` → the segment is optional.
          i++;
          re += "(?:.*/)?";
        } else {
          // Trailing `**` (e.g. `src/**`) must match everything beneath, files
          // included. `(?:.*/)?` only matches dir-like paths ending in `/`, so a
          // bare trailing `**` would match ZERO files — use `.*` instead.
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`);
}

// Compile a list of globs into a single predicate (matches if ANY glob matches).
// An empty/undefined list yields `null` so callers can skip the test entirely.
export function compileGlobs(globs: string[] | undefined): ((rel: string) => boolean) | null {
  if (!globs || globs.length === 0) return null;
  const res = globs.map(globToRegExp);
  return (rel: string) => res.some((r) => r.test(rel));
}

// Directory pruning for a walk filtered by `globs`: whether the directory `dir`
// (repo-relative posix, non-empty) can hold a path that ANY of them matches.
// The walk asks before descending, so a scoped or included subtree is walked
// and the rest is never listed or stat'd — `--scope` over 186 files of
// typescript-go used to stat all 66k.
//
// Decided segment by segment. `*` and `?` never cross `/`, so a glob without
// `**` matches paths of exactly its own segment count: each segment of `dir`
// must match the glob's segment at the same depth, and the glob must keep at
// least one segment for what lies inside. From a segment holding `**` on,
// anything can match: true. Never false for a directory that holds a match —
// the file test still has the last word, so erring towards descending only
// costs time.
export function compileDirGlobs(globs: string[] | undefined): ((dir: string) => boolean) | null {
  if (!globs || globs.length === 0) return null;
  // Per glob: one regex per segment, null for a `**` segment.
  const compiled = globs.map((g) => g.split("/").map((seg) => (seg.includes("**") ? null : globToRegExp(seg))));
  return (dir: string) => {
    const parts = dir.split("/");
    return compiled.some((segs) => {
      for (let i = 0; i < parts.length; i++) {
        const seg = segs[i];
        if (seg === undefined) return false; // the glob ends above this depth
        if (seg === null) return true;
        if (!seg.test(parts[i]!)) return false;
      }
      return parts.length < segs.length;
    });
  };
}

// The directories an exclude list removes WHOLE: a `<prefix>/**` glob whose
// prefix matches the directory matches every path beneath it too, so the walk
// can skip it unlisted. Any other exclude glob is left to the per-file test.
export function compileDirExcludes(globs: string[] | undefined): ((dir: string) => boolean) | null {
  const whole = (globs ?? []).filter((g) => g.endsWith("/**") && g.length > 3).map((g) => globToRegExp(g.slice(0, -3)));
  if (whole.length === 0) return null;
  return (dir: string) => whole.some((r) => r.test(dir));
}

// Negation-aware variant: `!`-prefixed globs EXCLUDE. A path passes when it
// matches at least one positive glob (or none are given — negations alone
// mean "everything but") AND matches no negated glob. Exclusion wins over
// inclusion regardless of list order — grep.ts feeds ripgrep the same way
// (positives first, negations last) so both backends agree.
export function compileGlobFilter(globs: string[] | undefined): ((rel: string) => boolean) | null {
  if (!globs || globs.length === 0) return null;
  const include = compileGlobs(globs.filter((g) => !g.startsWith("!")));
  const exclude = compileGlobs(globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1)));
  return (rel: string) => (!include || include(rel)) && !exclude?.(rel);
}
