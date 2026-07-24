import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { ENGINE_VERSION } from "../types.js";

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
  ".scala": "scala", ".sc": "scala",
  ".sh": "bash", ".bash": "bash",
  ".lua": "lua",
};

export function grammarKeyForExt(ext: string): string | undefined {
  return EXT_GRAMMAR[ext];
}

// Which supplier furnished the resolved grammars dir. Reported by
// `codeindex grammars status`; "none" is the regex-tier signal.
export type GrammarsTierName = "adjacent" | "env" | "cache" | "none";

export interface GrammarsTier {
  tier: GrammarsTierName;
  dir?: string; // undefined only when tier === "none"
  cacheDir: string; // where a `grammars pull` would extract, regardless of tier
}

// The shared, version-scoped cache a `grammars pull` extracts into and the
// resolver falls back to when no wasm ships next to the bundle. Version-scoped
// so a consumer bumping the engine never loads a stale grammar set: a new
// ENGINE_VERSION points at a fresh, empty dir until its own pull runs (and the
// old dir's bytes remain byte-identical to what that engine shipped). Honors
// XDG_CACHE_HOME, else ~/.cache — the platform-neutral, dependency-free
// convention already used by the wider toolchain.
export function sharedGrammarsCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() ? xdg.trim() : join(homedir(), ".cache");
  return join(base, "codeindex", "grammars", ENGINE_VERSION);
}

// Resolve the grammars dir AND record which tier supplied it, IN ORDER:
//   1. an explicit CODEINDEX_GRAMMAR_DIR / ULTRAINDEX_GRAMMAR_DIR override
//      (legacy, singular; kept winning outright so vendored/test setups that
//      pin it behave exactly as before) — reported as the "env" tier;
//   2. (a) the bundle-adjacent grammars/ dir — the shipped default: works from
//      the tsup bundle (scripts/engine.mjs → scripts/grammars), a consumer's
//      vendored copy (src/vendor → ../../scripts/grammars) or source under
//      vitest (src/ast → ../../scripts/grammars). Wins if present, so the
//      offline, no-network story is untouched;
//   3. (b) CODEINDEX_GRAMMARS_DIR — an explicit shared/custom dir override;
//   4. (c) the shared version-scoped cache a `grammars pull` populates;
//   5. (d) nothing resolvable → tier "none", dir undefined → the regex tier.
// Never touches the network and never throws. `moduleDir` overrides the
// module-relative base of the bundle-adjacent probe (tests/tooling only).
export function resolveGrammarsTier(opts: { moduleDir?: string } = {}): GrammarsTier {
  const cacheDir = sharedGrammarsCacheDir();
  const legacy = process.env.CODEINDEX_GRAMMAR_DIR ?? process.env.ULTRAINDEX_GRAMMAR_DIR;
  if (legacy && legacy.trim() && existsSync(legacy)) return { tier: "env", dir: legacy, cacheDir };
  const here = opts.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const adjacent = [
    join(here, "grammars"), // bundle: <...>/scripts/grammars
    join(here, "..", "..", "scripts", "grammars"), // dev: src/ast → <repo>/scripts/grammars
    join(here, "..", "scripts", "grammars"),
  ];
  for (const c of adjacent) if (existsSync(c)) return { tier: "adjacent", dir: c, cacheDir };
  const env = process.env.CODEINDEX_GRAMMARS_DIR;
  if (env && env.trim() && existsSync(env)) return { tier: "env", dir: env, cacheDir };
  if (existsSync(cacheDir)) return { tier: "cache", dir: cacheDir, cacheDir };
  return { tier: "none", cacheDir };
}

// The chosen grammars dir, or undefined when nothing is resolvable anywhere
// (the caller then stays on the regex tier). Additive companion to
// resolveGrammarsTier — same resolution, dir only.
export function resolveGrammarsDir(opts?: { moduleDir?: string }): string | undefined {
  return resolveGrammarsTier(opts).dir;
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
  const dir = resolveGrammarsDir();
  if (!dir) return; // nothing resolvable (adjacent/env/cache all absent) → regex everywhere
  if (!runtimeReady) {
    const runtime = join(dir, "web-tree-sitter.wasm");
    if (!existsSync(runtime)) return; // dir present but no runtime wasm → regex fallback everywhere
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

// The grammar keys needed for a set of file extensions: each mapped through
// EXT_GRAMMAR, unknown extensions dropped, then deduped and sorted. Warming
// exactly this set (instead of every committed grammar) skips the wasm load for
// languages the repo doesn't contain, while keeping output byte-identical:
// extractAst falls back to regex only when grammarReady(key) is false, and the
// walk's extension set (which feeds this) is a superset of what scanRepo keeps,
// so every extracted file has its grammar loaded. Language.load calls are
// independent, so loading fewer grammars cannot change parses of loaded ones.
export function grammarKeysForExts(exts: Iterable<string>): string[] {
  const keys = new Set<string>();
  for (const ext of exts) {
    const key = EXT_GRAMMAR[ext];
    if (key !== undefined) keys.add(key);
  }
  return [...keys].sort();
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
