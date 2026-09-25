// .gitignore support for the walker. Semantics follow git's core rules: per-
// directory files apply to their subtree, later rules win, `!` negates, a
// trailing `/` restricts to directories, a `/` anywhere else anchors the
// pattern to the .gitignore's own directory, `*`/`**`/`?` glob (never crossing
// `/` except `**`), `[...]` character classes, and `\x` fnmatch escapes.
// Verified by differential testing against `git check-ignore`. Two deliberate
// deviations: (1) once a directory is ignored the walk never descends into it,
// so a negation cannot re-include a file inside it — git behaves the same;
// (2) matching is ALWAYS case-sensitive (gitignore(5) semantics) even where
// git's platform default is core.ignorecase=true — a platform-dependent match
// would break cross-machine byte-identical builds.
import { escapeRegExp } from "./util.js";

export interface IgnoreRule {
  re: RegExp; // tested against the path RELATIVE TO THE REPO ROOT (posix)
  negated: boolean;
  dirOnly: boolean;
  // The same verdict as `re`, answered without a full-path regex where the
  // pattern allows it (see fastMatcher). Set by parseGitignore; a hand-built
  // rule without it is tested through `re`, exactly as before.
  test?: (rel: string, base: string) => boolean;
  // Where the rule was written, for `scan --why` to name the rule that decided
  // a path: the ignore file (as parseGitignore's caller names it), the 1-based
  // line, and the pattern as written there.
  source?: string;
  line?: number;
  pattern?: string;
}

// Compile one gitignore pattern segment-wise. Differs from glob.ts: `**` here
// follows gitignore's spec (`**/` leading, `/**` trailing, `/**/` mid-pattern),
// `\x` escapes the next character (fnmatch), and `[...]` character classes are
// supported (`*.py[cod]`, `[Tt]humbs.db`).
function patternToRegExpSource(pattern: string): string {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) {
      // fnmatch escaping: the next character is literal (`\*`, `\?`, `\ `, `\\`).
      re += escapeRegExp(pattern[++i]!);
    } else if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` is special only at segment boundaries (`**/`, `/**`, `/**/`,
        // or the whole pattern); anywhere else — `a**b` — git treats each
        // star as a regular single-segment `*`.
        const atStart = i === 0 || pattern[i - 1] === "/";
        let j = i;
        while (pattern[j + 1] === "*") j++;
        const next = pattern[j + 1];
        if (atStart && next === "/") {
          i = j + 1;
          re += "(?:[^/]+/)*"; // `**/` — zero or more whole segments
        } else if (atStart && next === undefined) {
          i = j;
          re += ".*"; // trailing `/**` or bare `**` — anything, crossing `/`
        } else {
          i = j;
          re += "[^/]*"; // mid-segment run of stars — one segment, like `*`
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      // Character class: consume up to the closing `]` (a leading `]` is
      // literal, `!` negates). Falls back to a literal `[` when unclosed.
      let j = i + 1;
      let body = "";
      if (pattern[j] === "!") {
        body += "^";
        j++;
      }
      if (pattern[j] === "]") {
        body += "\\]";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        const ch = pattern[j]!;
        body += ch === "\\" || ch === "^" ? "\\" + ch : ch;
        j++;
      }
      if (j < pattern.length && body !== "" && body !== "^") {
        // A bracket expression never matches `/` in git (wildmatch under
        // WM_PATHNAME), negated or not: `a[!x]b` leaves `a/b` alone. A bare
        // `[^x]` crossed the separator, so a floating class pattern could
        // ignore a path git keeps.
        re += body.startsWith("^") ? `[^/${body.slice(1)}]` : `(?!/)[${body}]`;
        i = j;
      } else {
        re += "\\[";
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  return re;
}

// Parse one .gitignore file. `baseRel` is the directory holding the file,
// relative to the repo root ("" for the root .gitignore), posix-style.
// `source`, when given, is recorded on each rule with its line (see IgnoreRule).
export function parseGitignore(content: string, baseRel: string, source?: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  const prefix = baseRel ? escapeRegExp(baseRel) + "/" : "";
  const lines = content.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    // Trailing SPACES are ignored unless backslash-escaped (git trims only
    // 0x20 — a trailing tab is significant). Blank lines and comments carry no
    // rule. Escapes (`\ `, `\*`, `\#`…) are consumed by the pattern compiler.
    let line = lines[n]!.replace(/(?<!\\) +$/, "");
    if (!line || line.startsWith("#")) continue;
    const written = line;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
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
    const reSource = anchored ? `^${prefix}${body}$` : `^${prefix}(?:[^/]+/)*${body}$`;
    try {
      const re = new RegExp(reSource);
      const rule: IgnoreRule = { re, negated, dirOnly, test: fastMatcher(line, body, anchored, baseRel ? baseRel + "/" : "", re) };
      if (source !== undefined) Object.assign(rule, { source, line: n + 1, pattern: written });
      rules.push(rule);
    } catch {
      // An unparsable pattern is dropped rather than crashing the walk.
    }
  }
  return rules;
}

// The pattern's literal head: its characters up to the first unescaped glob
// metacharacter, with fnmatch escapes consumed exactly as patternToRegExpSource
// consumes them. `whole` says the pattern had no metacharacter at all. `[` counts
// as one even when unclosed (then literal) — stopping early is always safe, the
// regex still decides.
function literalHead(pattern: string): { head: string; whole: boolean } {
  let head = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) head += pattern[++i]!;
    else if (c === "*" || c === "?" || c === "[") return { head, whole: false };
    else head += c;
  }
  return { head, whole: true };
}

// A cheaper matcher with the SAME verdict as the rule's full-path regex. Every
// file of a walk is tested against every rule in scope, and the floating form
// `^base/(?:[^/]+/)*body$` backtracks over each directory level: on a 66k-file
// repo whose root .gitignore holds 117 rules this was over half the walk time.
//
// A floating pattern contains no `/` (a slash anchors it), and no construct of
// its body can match one (bracket expressions exclude it, and `.*` comes only
// from a pattern made of stars alone, which matches any basename). So it
// matches exactly when the path lies under the .gitignore's directory and the
// body matches the BASENAME: a string compare for a literal (`node_modules`),
// a suffix test for `*<literal>` (`*.log`), else the body regex on the
// basename. An anchored pattern keeps its regex behind a literal-prefix check
// that rejects almost every path at the first differing character.
function fastMatcher(
  pattern: string,
  body: string,
  anchored: boolean,
  prefix: string,
  re: RegExp,
): (rel: string, base: string) => boolean {
  if (anchored) {
    const { head, whole } = literalHead(pattern);
    const full = prefix + head;
    if (whole) return (rel) => rel === full;
    return (rel) => rel.startsWith(full) && re.test(rel);
  }
  const { head, whole } = literalHead(pattern);
  if (whole) return (rel, base) => base === head && rel.startsWith(prefix);
  if (pattern[0] === "*" && pattern[1] !== "*") {
    const tail = literalHead(pattern.slice(1));
    if (tail.whole) return (rel, base) => base.endsWith(tail.head) && rel.startsWith(prefix);
  }
  const baseRe = new RegExp(`^${body}$`);
  return (rel, base) => rel.startsWith(prefix) && baseRe.test(base);
}

// Decide whether `rel` (posix, repo-root-relative) is ignored under an ordered
// rule chain (root rules first, deeper .gitignore rules appended after — which
// realizes "later rules win" across nesting levels too). Returns the verdict of
// the LAST matching rule, or false when none match.
export function isIgnored(rules: readonly IgnoreRule[], rel: string, isDir: boolean): boolean {
  const rule = decidingRule(rules, rel, isDir);
  return rule !== undefined && !rule.negated;
}

// The rule whose verdict isIgnored returns: the LAST one matching `rel`, or
// undefined when none does. Scanned from the END: the first rule that matches
// there is the last match, so the rest of the chain is never tested.
export function decidingRule(rules: readonly IgnoreRule[], rel: string, isDir: boolean): IgnoreRule | undefined {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (rule.dirOnly && !isDir) continue;
    if (rule.test ? rule.test(rel, base) : rule.re.test(rel)) return rule;
  }
  return undefined;
}
