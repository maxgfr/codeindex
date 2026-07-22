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
};

export function extToLang(ext: string): string {
  return EXT_LANG[ext] ?? "other";
}
