import type { CodeSymbol } from "../types.js";

// A line-level extraction rule. `re` must capture the symbol name in a named
// group `name` (or capture group 1). One symbol is emitted per matching line
// (first rule wins), which keeps the heuristics cheap and predictable.
export interface Rule {
  re: RegExp;
  kind: string;
  exported?: boolean | ((m: RegExpExecArray, line: string) => boolean);
}

// Run a list of rules line-by-line over file content. Deterministic and
// zero-dep — no parser, no AST, no LLM. Good enough to locate declarations and
// rank them; ripgrep covers everything inside bodies.
export function scan(rel: string, content: string, lang: string, rules: Rule[]): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const name = m.groups?.name ?? m[1];
      if (!name) continue;
      const exported =
        typeof rule.exported === "function" ? rule.exported(m, line) : rule.exported ?? false;
      out.push({
        name,
        kind: rule.kind,
        file: rel,
        line: i + 1,
        signature: line.trim().slice(0, 200),
        exported,
        lang,
      });
      break;
    }
  }
  return out;
}

// Broad extension → language label table, used for the index's language
// histogram even when no symbol extractor exists for that language.
const EXT_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rb": "ruby", ".rake": "ruby",
  ".java": "java",
  ".rs": "rust",
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
  ".cs": "csharp", ".php": "php", ".swift": "swift", ".kt": "kotlin", ".kts": "kotlin",
  ".scala": "scala", ".sc": "scala", ".clj": "clojure", ".ex": "elixir", ".exs": "elixir", ".erl": "erlang",
  ".hs": "haskell", ".dart": "dart", ".lua": "lua",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".ksh": "shell", ".fish": "shell",
  ".hh": "cpp", ".m": "objective-c", ".mm": "objective-c",
  ".sql": "sql", ".graphql": "graphql", ".gql": "graphql", ".proto": "protobuf",
  ".md": "markdown", ".mdx": "markdown", ".rst": "restructuredtext", ".txt": "text",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".ini": "ini",
  ".html": "html", ".css": "css", ".scss": "scss", ".vue": "vue", ".svelte": "svelte",
  ".astro": "astro",
  // Extended-tier AST languages (src/ast/loader.ts EXT_GRAMMAR). Without an
  // entry here `extToLang` answered "other", which `classify` reads as non-code
  // — so a real scan never called extractCode for them and they extracted
  // nothing, while the quality harness (which calls extractCode directly)
  // published a perfect score. The grammar still arrives via `grammars pull`;
  // absent it these fall back to the regex tier like any other language.
  ".zig": "zig", ".hcl": "hcl", ".tf": "terraform", ".tfvars": "terraform", ".sol": "solidity",
};

export function extToLang(ext: string): string {
  return EXT_LANG[ext] ?? "other";
}

const REEXPORT_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// Blank out comments while PRESERVING every byte offset and line break, so a
// scan that runs over the result can still report real line numbers.
//
// WHY: the barrel scan below is a regex over raw text. `src/lang/common.ts` used
// to index its OWN doc comment — the line that documents the feature contains
// `export { A, B as C } from './x'`, so the engine emitted symbols named `A` and
// `C` from its own prose. Found by the label-free invariant "a symbol's span must
// actually contain its name".
//
// String-aware, because `const s = "// not a comment"` must not be blanked.
// Template literals are treated as plain strings: an `${…}` expression cannot
// legally contain an unterminated comment, so nesting adds nothing here.
export function blankComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      // Blank the closing delimiter too, or `*/` would read as code.
      if (i < n) out[i] = " ";
      if (i + 1 < n) out[i + 1] = " ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") i++; // skip the escaped char
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

// Per-file re-export ceiling. Raised from 60: this engine's own public barrel
// (src/engine.ts) declares ~200 names, so 60 hid two thirds of its API — and it
// hid them SILENTLY, which is the one thing the walk's `capped` doctrine forbids.
// Crossing it now sets FileRecord.truncated (see extract/code.ts).
export const MAX_REEXPORTS = 400;


// Barrel re-exports (`export { A, B as C } from './x'`, `export * from './y'`).
// The line-based lang extractor can't capture multi-name lists, but these ARE
// the public facade of a module — so list them as exported symbols here.
//
// An ALIAS with no `from` clause (`export { b as c }`) renames an in-file
// declaration — `localSymbols` (already extracted by the AST or regex tier)
// lets us resolve `b` and mirror ITS kind, declaration line, and endLine (AST
// tier only) onto `c` (e.g. "function" at b's own line), so the alias reads
// as the real symbol it is — citeable at its actual declaration — rather than
// the generic "reexport" pinned to the export statement's line.
// A true cross-module re-export (`export { b as c } from "./mod"`) has no
// local `b` to resolve — and an alias the local pass genuinely can't see
// (destructured/ambient/etc.) falls back the same way — both keep "reexport"
// and cite the export statement's own line, the only line they have.
//
// Shared by extractCode (extract/code.ts) AND the standalone extractSymbols
// (lang/registry.ts) — ultradoc and other direct extractSymbols consumers hit
// the same barrels a repo scan does, so both entry points must agree; this is
// the one place the alias-mirroring logic lives, reused rather than
// reimplemented on either side.
export function extractReexports(rel: string, content: string, localSymbols: CodeSymbol[]): CodeSymbol[] {
  if (!REEXPORT_EXTS.has(rel.slice(rel.lastIndexOf(".")))) return [];
  const lang = /\.(ts|tsx|mts|cts)$/.test(rel) ? "typescript" : "javascript";
  const out: CodeSymbol[] = [];
  const seen = new Set<string>();
  const lineAt = (idx: number): number => content.slice(0, idx).split(/\r?\n/).length;
  // Keyed on the whole CodeSymbol (not just kind) so the alias branch below
  // can also cite the resolved declaration's own line/endLine, not just mirror
  // its kind.
  const localDeclOf = new Map<string, CodeSymbol>();
  for (const s of localSymbols) if (!localDeclOf.has(s.name)) localDeclOf.set(s.name, s);

  // Scanned over comment-blanked text, so the engine cannot index prose that
  // merely QUOTES an export statement. Offsets are preserved, so `lineAt` below
  // still reports real lines.
  const scanned = blankComments(content);
  const named = /export\s*\{([\s\S]*?)\}\s*(?:from\s*['"]([^'"]+)['"])?\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(scanned)) && out.length < MAX_REEXPORTS) {
    const from = m[2];
    // Offset of the name list inside `content`, so each name can cite ITS OWN
    // line. A formatter-wrapped 20-name barrel used to pin every one of them to
    // the `export {` line, sending jump-to-definition to the wrong place.
    const listAt = m.index + m[0].indexOf("{") + 1;
    let cursor = 0;
    for (const part of m[1]!.split(",")) {
      const partAt = listAt + cursor;
      cursor += part.length + 1; // +1 for the comma the split consumed
      const p = part.trim().replace(/^type\s+/, "");
      const as = /^(\S+)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(p);
      const orig = as ? as[1]! : p;
      const name = as ? as[2]! : p;
      if (!/^[A-Za-z_$][\w$]*$/.test(name) || name === "default" || seen.has(name)) continue;
      seen.add(name);
      // A resolved decl means this is a same-file alias: cite ITS line (and
      // endLine, when the AST tier populated one) rather than the export
      // statement's — an unresolved alias or a `from`-clause re-export has no
      // local declaration to point at, so it keeps lineAt(m.index) below.
      const decl = !from ? localDeclOf.get(orig) : undefined;
      out.push({
        name, kind: decl?.kind ?? "reexport", file: rel, line: decl ? decl.line : lineAt(partAt),
        ...(decl?.endLine !== undefined ? { endLine: decl.endLine } : {}),
        signature: from ? `export { ${name} } from "${from}"` : `export { ${name} }`,
        exported: true, lang,
      });
    }
  }

  const star = /export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/g;
  while ((m = star.exec(scanned)) && out.length < MAX_REEXPORTS) {
    const ns = m[1];
    const from = m[2]!;
    const key = "*" + (ns ?? from);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: ns ?? `* (${from})`, kind: ns ? "reexport" : "reexport-all", file: rel,
      line: lineAt(m.index), signature: `export * ${ns ? `as ${ns} ` : ""}from "${from}"`,
      exported: true, lang,
    });
  }
  return out;
}
