// Literal extraction for `config`-kind files (JSON / YAML / TOML / INI).
//
// These files were catalogued and never read: `scanRepo` gave them a title and
// nothing else. That is fine for a symbol index and wrong for a value index,
// because the duplications that actually hurt are the ones that CROSS a
// language boundary — a threshold declared once in TypeScript and again in a
// rules JSON, a field name in a mapping table and again in an OpenAPI spec, a
// route called from a Kubernetes manifest. No compiler looks at those pairs,
// so nothing else will ever report them.
//
// Deliberately a line scanner, not a parser: it must work on every dialect at
// once (JSON with comments, YAML anchors, TOML, .env-shaped INI), survive a
// malformed file, and — the reason a parser is disqualified outright — report
// the LINE each value sits on. A parsed tree does not carry one.
import type { CodeLiteral } from "../types.js";
import { LiteralCollector } from "./literals.js";

// Both sides of a mapping are worth keeping. A key in one file is routinely a
// value in another: the GIP field names that egapro writes as object keys in
// its OpenAPI spec are string values in its label table, and only comparing
// both catches the drift between them.
//
// Double quotes take backslash escapes. Single quotes take none: a YAML
// single-quoted scalar escapes a quote by doubling it (`'it''s'`), a TOML
// literal string cannot contain one, and in both a backslash is just a
// character (`'C:\dir\'`).
const QUOTED = /"((?:\\.|[^"\\])*)"|'((?:[^']|'')*)'/g;
// Non-global twin: `.test()` on a /g regex advances lastIndex, so reusing
// QUOTED for a predicate makes the NEXT match on the same line start mid-string.
const HAS_QUOTE = /"(?:\\.|[^"\\])*"|'(?:[^']|'')*'/;
const BARE_NUMBER = /(?<![\w.$-])-?\d[\d_]*(?:\.\d+)?(?![\w.$-])/g;
// A whole value that is one number, as BARE_NUMBER reads it.
const NUMBER = /^-?\d[\d_]*(?:\.\d+)?$/;
// YAML/TOML/INI unquoted scalar after `key:` or `key =`, including a YAML
// sequence entry's (`- name: web`). JSON never needs this; YAML overwhelmingly
// does, since quoting is optional there.
const UNQUOTED_SCALAR = /^\s*(?:-\s+)?[\w.$-]+\s*[:=]\s*([^#\n]+?)\s*$/;

export function extractConfigLiterals(content: string): CodeLiteral[] | undefined {
  const literals = new LiteralCollector();
  let lineNo = 0;
  for (const raw of content.split("\n")) {
    lineNo++;
    if (literals.full) break;
    // `#` opens a comment in YAML/TOML/INI; inside a quoted run it does not, so
    // strip only what follows the last closing quote on the line.
    const line = stripTrailingComment(raw);

    for (const m of line.matchAll(QUOTED)) {
      literals.add("string", m[1] ?? m[2]!.replace(/''/g, "'"), lineNo);
    }

    // An unquoted scalar is ONE value. A number (`port: 8080`) is recorded
    // once, as the number below; anything else (`time: 12:30:45`,
    // `host: db:5432`) is a string, and the digits inside it are part of it,
    // not values of their own. Counting both made every numeric setting a
    // duplicate of itself and a time three unrelated thresholds.
    const bare = UNQUOTED_SCALAR.exec(line);
    const v = bare?.[1]!.trim();
    // Structural YAML/TOML punctuation opening a block, not a value.
    const scalar = v && !/^[[{|>&*-]/.test(v) && !HAS_QUOTE.test(v) ? v : undefined;
    if (scalar !== undefined && !NUMBER.test(scalar)) {
      literals.add("string", scalar, lineNo);
      continue;
    }

    for (const m of line.replace(QUOTED, " ").matchAll(BARE_NUMBER)) {
      literals.add("number", m[0].replace(/_/g, ""), lineNo);
    }
  }
  return literals.result();
}

// Drops a `#` comment tail, but only when the `#` sits outside every quoted
// run on the line — `"url": "http://x/#frag"` is a value, not a comment.
function stripTrailingComment(line: string): string {
  let inQuote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuote) {
      // Only a double-quoted run has escapes; see QUOTED.
      if (c === "\\" && inQuote === '"') i++;
      else if (c === inQuote) inQuote = undefined;
    } else if (c === '"' || c === "'") inQuote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}
