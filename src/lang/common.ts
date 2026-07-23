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
};

export function extToLang(ext: string): string {
  return EXT_LANG[ext] ?? "other";
}

const REEXPORT_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// Barrel re-exports (`export { A, B as C } from './x'`, `export * from './y'`).
// The line-based lang extractor can't capture multi-name lists, but these ARE
// the public facade of a module — so list them as exported symbols here.
//
// An ALIAS with no `from` clause (`export { b as c }`) renames an in-file
// declaration — `localSymbols` (already extracted by the AST or regex tier)
// lets us resolve `b` and mirror ITS kind onto `c` (e.g. "function"), so the
// alias reads as the real symbol it is rather than the generic "reexport".
// A true cross-module re-export (`export { b as c } from "./mod"`) has no
// local `b` to resolve — and an alias the local pass genuinely can't see
// (destructured/ambient/etc.) falls back the same way — both keep "reexport".
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
  const localKindOf = new Map<string, string>();
  for (const s of localSymbols) if (!localKindOf.has(s.name)) localKindOf.set(s.name, s.kind);

  const named = /export\s*\{([\s\S]*?)\}\s*(?:from\s*['"]([^'"]+)['"])?\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(content)) && out.length < 60) {
    const from = m[2];
    for (const part of m[1]!.split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      const as = /^(\S+)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(p);
      const orig = as ? as[1]! : p;
      const name = as ? as[2]! : p;
      if (!/^[A-Za-z_$][\w$]*$/.test(name) || name === "default" || seen.has(name)) continue;
      seen.add(name);
      const mirroredKind = !from ? localKindOf.get(orig) : undefined;
      out.push({
        name, kind: mirroredKind ?? "reexport", file: rel, line: lineAt(m.index),
        signature: from ? `export { ${name} } from "${from}"` : `export { ${name} }`,
        exported: true, lang,
      });
    }
  }

  const star = /export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/g;
  while ((m = star.exec(content)) && out.length < 60) {
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
