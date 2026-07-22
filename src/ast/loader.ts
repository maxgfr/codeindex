import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";

// Extension → committed grammar wasm key (scripts/grammars/<key>.wasm). Only the
// languages we ship a grammar for appear here; everything else falls back to the
// regex extractors (still fully searchable, just no AST-exact symbols/imports).
export const EXT_GRAMMAR: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby", ".rake": "ruby",
  ".c": "c", ".h": "c",
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
  ".cs": "c_sharp",
  ".php": "php",
};

export function grammarKeyForExt(ext: string): string | undefined {
  return EXT_GRAMMAR[ext];
}

// Where the committed wasms live. Resolved relative to this module so the
// SAME logic works whether we run from the tsup bundle (scripts/engine.mjs →
// scripts/grammars), from a consumer's vendored copy (src/vendor →
// ../../scripts/grammars), or from source under vitest (src/ast →
// ../../scripts/grammars). CODEINDEX_GRAMMAR_DIR overrides for tests/tooling
// (ULTRAINDEX_GRAMMAR_DIR kept as a legacy alias).
function resolveGrammarDir(): string {
  const env = process.env.CODEINDEX_GRAMMAR_DIR ?? process.env.ULTRAINDEX_GRAMMAR_DIR;
  if (env && existsSync(env)) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "grammars"), // bundle: <...>/scripts/grammars
    join(here, "..", "..", "scripts", "grammars"), // dev: src/ast → <repo>/scripts/grammars
    join(here, "..", "scripts", "grammars"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return join(here, "grammars");
}

// tree-sitter's runtime + grammars must be initialised asynchronously (wasm
// instantiation). We do that ONCE at the CLI/test boundary, then extraction is
// fully synchronous (parser.parse is sync) — so the scan pipeline itself never
// becomes async. No worker_threads: parsing is CPU-bound but per-file cheap, and
// the incremental cache removes the repeated cost; a single deterministic thread
// keeps byte-identical rebuilds trivially guaranteed.
let runtimeReady = false;
let parser: Parser | null = null;
const loaded = new Map<string, Language>();
const failed = new Set<string>();

// Load the runtime (once) and the requested grammar keys (each once). Idempotent
// and safe to call repeatedly. A missing/broken wasm is remembered as failed so
// the caller silently falls back to regex rather than retrying every file.
export async function ensureGrammars(keys: Iterable<string>): Promise<void> {
  const dir = resolveGrammarDir();
  if (!runtimeReady) {
    const runtime = join(dir, "web-tree-sitter.wasm");
    if (!existsSync(runtime)) return; // no committed grammars → regex fallback everywhere
    await Parser.init({ wasmBinary: readFileSync(runtime) as unknown as Uint8Array });
    runtimeReady = true;
    parser = new Parser();
  }
  for (const key of new Set(keys)) {
    if (loaded.has(key) || failed.has(key)) continue;
    const wasm = join(dir, `${key}.wasm`);
    if (!existsSync(wasm)) {
      failed.add(key);
      continue;
    }
    try {
      loaded.set(key, await Language.load(new Uint8Array(readFileSync(wasm))));
    } catch {
      failed.add(key);
    }
  }
}

// All grammar keys we ship — used by the CLI/tests to warm every grammar upfront.
export function allGrammarKeys(): string[] {
  return [...new Set(Object.values(EXT_GRAMMAR))];
}

export function grammarReady(key: string): boolean {
  return loaded.has(key);
}

// The shared parser, with `key`'s grammar selected. Returns null when the grammar
// is not loaded (caller uses the regex extractor). Sync — parse happens after.
export function parserFor(key: string): Parser | null {
  const lang = loaded.get(key);
  if (!parser || !lang) return null;
  parser.setLanguage(lang);
  return parser;
}
