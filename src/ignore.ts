// .gitignore support for the walker. Semantics follow git's core rules for the
// common cases: per-directory files apply to their subtree, later rules win,
// `!` negates, a trailing `/` restricts to directories, a `/` anywhere else
// anchors the pattern to the .gitignore's own directory, and `*`/`**`/`?` glob
// (never crossing `/` except `**`). Deliberate simplification shared with git
// itself: once a directory is ignored the walk never descends into it, so a
// negation cannot re-include a file inside an ignored directory.
import { escapeRegExp } from "./util.js";

export interface IgnoreRule {
  re: RegExp; // tested against the path RELATIVE TO THE REPO ROOT (posix)
  negated: boolean;
  dirOnly: boolean;
}

// Compile one gitignore pattern segment-wise. Differs from glob.ts: `**` here
// follows gitignore's spec (`**/` leading, `/**` trailing, `/**/` mid-pattern).
function patternToRegExpSource(pattern: string): string {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:[^/]+/)*"; // `**/` — zero or more whole segments
        } else {
          re += ".*"; // trailing `**` (or bare) — anything, crossing `/`
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
  return re;
}

// Parse one .gitignore file. `baseRel` is the directory holding the file,
// relative to the repo root ("" for the root .gitignore), posix-style.
export function parseGitignore(content: string, baseRel: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  const prefix = baseRel ? escapeRegExp(baseRel) + "/" : "";
  for (const rawLine of content.split(/\r?\n/)) {
    // Trailing spaces are ignored unless backslash-escaped (rare; we keep the
    // simple form). Blank lines and comments carry no rule.
    let line = rawLine.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    // A slash anywhere (leading or interior) anchors the pattern to the base
    // directory; otherwise it floats to any depth beneath it.
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const body = patternToRegExpSource(line);
    const source = anchored ? `^${prefix}${body}$` : `^${prefix}(?:[^/]+/)*${body}$`;
    try {
      rules.push({ re: new RegExp(source), negated, dirOnly });
    } catch {
      // An unparsable pattern is dropped rather than crashing the walk.
    }
  }
  return rules;
}

// Decide whether `rel` (posix, repo-root-relative) is ignored under an ordered
// rule chain (root rules first, deeper .gitignore rules appended after — which
// realizes "later rules win" across nesting levels too). Returns the verdict of
// the LAST matching rule, or false when none match.
export function isIgnored(rules: readonly IgnoreRule[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.re.test(rel)) ignored = !rule.negated;
  }
  return ignored;
}
