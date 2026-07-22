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
