import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { ENGINE_VERSION } from "../types.js";

// Extension → committed grammar wasm key (scripts/grammars/<key>.wasm). Only the
// languages we ship a grammar for appear here; everything else falls back to the
// regex extractors (still fully searchable, just no AST-exact symbols/imports).
// The COMMITTED tier: shipped in scripts/grammars/, available to every consumer
// with no network and no install.
export const CORE_GRAMMARS = new Set([
  "typescript", "tsx", "javascript", "python", "go", "rust", "java",
  "ruby", "c", "cpp", "c_sharp", "php", "scala", "bash", "lua",
]);

// The PULL-ONLY tier: published in the per-release grammars asset, not in git
// (see scripts/fetch-grammars.mjs). Absent until `codeindex grammars pull`, and
// absent is fine — the engine falls back to the regex tier for these exactly as
// it does for a language with no grammar at all.
export const EXTENDED_GRAMMARS = new Set(["kotlin", "elixir", "zig", "hcl", "terraform", "solidity"]);

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
  // Extended tier — resolvable only after a `grammars pull`.
  ".kt": "kotlin", ".kts": "kotlin",
  ".ex": "elixir", ".exs": "elixir",
  ".zig": "zig",
  ".hcl": "hcl",
  ".tf": "terraform", ".tfvars": "terraform",
  ".sol": "solidity",
};

// Single-file components have no grammar of their own: their `<script>` blocks
// are parsed with the JS/TS grammar their `lang` attribute names (see
// extract/sfc.ts). Kept out of EXT_GRAMMAR, which maps a file to the grammar
// that parses the WHOLE file, but warmed with it (grammarKeysForExts).
const EMBEDDED_GRAMMARS: Record<string, string[]> = {
  ".vue": ["javascript", "tsx", "typescript"],
  ".svelte": ["javascript", "tsx", "typescript"],
  ".astro": ["typescript"],
};

export function grammarKeyForExt(ext: string): string | undefined {
  return EXT_GRAMMAR[ext];
}

// `.h` is the one extension two shipped grammars claim. It maps to C, and a C++
// header parsed as C is mostly ERROR nodes: leveldb's 56 headers yielded 142
// symbols that way against 963 as C++ — fewer than the regex tier found — with
// `namespace leveldb` read as a function and the whole `DB` class gone. Parsing
// every `.h` as C++ is no fix either, since a pure-C header (cJSON's) loses a
// third of its symbols to C++'s stricter grammar. So the content decides, on
// constructs C cannot contain: a namespace block or `using namespace`, a
// template, a class head (optionally behind an export macro:
// `class LEVELDB_EXPORT DB {`), an access specifier, a standard C++ include
// (`<string>` — C's are all `.h`), or `extern "C++"`. Each alternative is
// anchored at a line start so prose in a comment rarely trips it, and leading
// indentation is `[ \t]*` so a run of blank lines is never rescanned.
// Deterministic: a pure function of the bytes.
const CPP_HEADER =
  /^[ \t]*(?:namespace(?:[ \t]+[A-Za-z_][\w:]*)?\s*\{|using[ \t]+namespace[ \t]|template[ \t]*<|class[ \t]+(?:[A-Z_][A-Z0-9_]*[ \t]+)?[A-Za-z_]\w*(?:[ \t]+final)?[ \t]*(?:[:;{]|$)|(?:public|private|protected)[ \t]*:(?!:)|#[ \t]*include[ \t]*<[a-z_]+>|extern[ \t]+"C\+\+")/m;

// The grammar to parse ONE file with: the extension's, except a `.h` whose
// content reads as C++ (above). The file keeps its "c" language either way —
// c and cpp are one family for every cross-file join — so this changes how the
// header is parsed, not what it is.
export function grammarKeyFor(ext: string, content: string): string | undefined {
  const key = EXT_GRAMMAR[ext];
  return ext === ".h" && CPP_HEADER.test(content) ? "cpp" : key;
}

// Which supplier furnished the resolved grammars dir. Reported by
// `codeindex grammars status`; "none" is the regex-tier signal.
export type GrammarsTierName = "adjacent" | "env" | "cache" | "none";

export interface GrammarsTier {
  tier: GrammarsTierName;
  dir?: string; // undefined only when tier === "none"
  cacheDir: string; // where a `grammars pull` would extract, regardless of tier
  // Every directory a grammar may be loaded from, in precedence order, each
  // probed per key (ensureGrammars takes the first dir holding `<key>.wasm`).
  // `dir` comes first, then the sibling `grammars-extended/` that
  // `fetch-grammars.mjs --extended` writes in a DEV checkout, then — unless
  // the legacy CODEINDEX_GRAMMAR_DIR pins one dir outright — the lower tiers
  // that exist (CODEINDEX_GRAMMARS_DIR, the pulled shared cache). The chain is
  // what lets the npm layout work: it ships only the CORE wasms next to the
  // bundle, so with `dirs` stopping at the adjacent dir the EXTENDED wasms a
  // `grammars pull` put in the cache were never searched and Kotlin, Elixir,
  // Zig, Solidity, HCL and Terraform stayed on the regex tier for good. The
  // bytes of a key are the same in every tier of one ENGINE_VERSION, so which
  // dir supplies it never shows in the output.
  dirs: string[];
}

// The shared, version-scoped cache a `grammars pull` extracts into and the
// resolver falls back to when no wasm ships next to the bundle. Version-scoped
// so a consumer bumping the engine never loads a stale grammar set: a new
// ENGINE_VERSION points at a fresh, empty dir until its own pull runs (and the
// old dir's bytes remain byte-identical to what that engine shipped). Honors
// XDG_CACHE_HOME, else ~/.cache — the platform-neutral, dependency-free
// convention already used by the wider toolchain.
// Sibling directory name for the pull-only tier in a dev checkout.
const EXTENDED_DIR = "grammars-extended";

export function sharedGrammarsCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() ? xdg.trim() : join(homedir(), ".cache");
  return join(base, "codeindex", "grammars", ENGINE_VERSION);
}

// Resolve the grammars dir AND record which tier supplied it, IN ORDER:
//   1. an explicit CODEINDEX_GRAMMAR_DIR / ULTRAINDEX_GRAMMAR_DIR override
//      (legacy, singular; kept winning outright so vendored/test setups that
//      pin it behave exactly as before, with no fallback behind it) —
//      reported as the "env" tier;
//   2. (a) the bundle-adjacent grammars/ dir — the shipped default: works from
//      the tsup bundle (scripts/engine.mjs → scripts/grammars), a consumer's
//      vendored copy (src/vendor → ../../scripts/grammars) or source under
//      vitest (src/ast → ../../scripts/grammars). Wins if present, so the
//      offline, no-network story is untouched;
//   3. (b) CODEINDEX_GRAMMARS_DIR — an explicit shared/custom dir override;
//   4. (c) the shared version-scoped cache a `grammars pull` populates;
//   5. (d) nothing resolvable → tier "none", dir undefined → the regex tier.
// The winner names the tier and `dir`; the tiers below it that exist stay in
// `dirs` as per-key fallbacks (see GrammarsTier.dirs).
// Never touches the network and never throws. `moduleDir` overrides the
// module-relative base of the bundle-adjacent probe (tests/tooling only).
export function resolveGrammarsTier(opts: { moduleDir?: string } = {}): GrammarsTier {
  const cacheDir = sharedGrammarsCacheDir();
  const env = process.env.CODEINDEX_GRAMMARS_DIR;
  const envDir = env && env.trim() && existsSync(env) ? env : undefined;
  const cached = existsSync(cacheDir) ? cacheDir : undefined;
  const withDirs = (tier: GrammarsTierName, dir: string, fallbacks: (string | undefined)[]): GrammarsTier => {
    const sibling = join(dir, "..", EXTENDED_DIR);
    const dirs: string[] = [];
    for (const d of [dir, existsSync(sibling) ? sibling : undefined, ...fallbacks]) {
      if (d !== undefined && !dirs.includes(d)) dirs.push(d);
    }
    return { tier, dir, cacheDir, dirs };
  };
  // The legacy override keeps its "one pinned dir" contract: vendored and test
  // setups point it at a deliberately partial set, and a user's pulled cache
  // leaking in behind it would silently change what those setups measure.
  const legacy = process.env.CODEINDEX_GRAMMAR_DIR ?? process.env.ULTRAINDEX_GRAMMAR_DIR;
  if (legacy && legacy.trim() && existsSync(legacy)) return withDirs("env", legacy, []);
  const here = opts.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const adjacent = [
    join(here, "grammars"), // bundle: <...>/scripts/grammars
    join(here, "..", "..", "scripts", "grammars"), // dev: src/ast → <repo>/scripts/grammars
    join(here, "..", "scripts", "grammars"),
  ];
  for (const c of adjacent) if (existsSync(c)) return withDirs("adjacent", c, [envDir, cached]);
  if (envDir) return withDirs("env", envDir, [cached]);
  if (cached) return withDirs("cache", cached, []);
  return { tier: "none", cacheDir, dirs: [] };
}

// The grammar keys ensureGrammars WOULD load right now — the runtime wasm and
// `<key>.wasm` present somewhere in the resolved dirs — known from existsSync
// alone, without instantiating any wasm. Lets a caller predict the extraction
// tier before deciding whether to warm at all (see src/preload.ts). A present
// but broken wasm is predicted ready and then fails to load; callers that go on
// to warm re-check with grammarReady.
export function resolvableGrammarKeys(): Set<string> {
  const { dirs } = resolveGrammarsTier();
  const present = (name: string): boolean => dirs.some((d) => existsSync(join(d, name)));
  if (!present("web-tree-sitter.wasm")) return new Set();
  return new Set(allGrammarKeys().filter((key) => present(`${key}.wasm`)));
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
const failed = new Map<string, string>();

// Load the runtime (once) and the requested grammar keys (each once). Idempotent
// and safe to call repeatedly. A missing/broken wasm is remembered together
// with the state that failed. If a browser mount, pull, or disk replacement
// changes that state, the next call retries instead of poisoning the process
// for its entire lifetime.
export async function ensureGrammars(keys: Iterable<string>): Promise<void> {
  const { dirs } = resolveGrammarsTier();
  if (!dirs.length) return; // nothing resolvable (adjacent/env/cache all absent) → regex everywhere
  const firstIn = (name: string): string | undefined => {
    for (const d of dirs) {
      const p = join(d, name);
      if (existsSync(p)) return p;
    }
    return undefined;
  };
  if (!runtimeReady) {
    const runtime = firstIn("web-tree-sitter.wasm");
    if (!runtime) return; // dir present but no runtime wasm → regex fallback everywhere
    await Parser.init({ wasmBinary: readFileSync(runtime) as unknown as Uint8Array });
    runtimeReady = true;
    parser = new Parser();
  }
  for (const key of new Set(keys)) {
    if (loaded.has(key)) continue;
    const wasm = firstIn(`${key}.wasm`);
    const fingerprint = wasm
      ? (() => {
          try {
            const st = statSync(wasm);
            return `${wasm}:${st.size}:${st.mtimeMs}`;
          } catch {
            return `${wasm}:unreadable`;
          }
        })()
      : `missing:${dirs.join("|")}`;
    if (failed.get(key) === fingerprint) continue;
    if (!wasm) {
      failed.set(key, fingerprint);
      continue;
    }
    try {
      loaded.set(key, await Language.load(new Uint8Array(readFileSync(wasm))));
      failed.delete(key);
    } catch {
      failed.set(key, fingerprint);
    }
  }
}

// All grammar keys we ship — used by the CLI/tests to warm every grammar upfront.
export function allGrammarKeys(): string[] {
  return [...new Set(Object.values(EXT_GRAMMAR))];
}

// The grammar keys needed for a set of file extensions: each mapped through
// EXT_GRAMMAR (and `.h` to cpp as well — see grammarKeyFor), unknown extensions
// dropped, then deduped and sorted. Warming
// exactly this set (instead of every committed grammar) skips the wasm load for
// languages the repo doesn't contain, while keeping output byte-identical:
// extractAst falls back to regex only when grammarReady(key) is false, and the
// walk's extension set (which feeds this) is a superset of what scanRepo keeps,
// so every extracted file has its grammar loaded. Language.load calls are
// independent, so loading fewer grammars cannot change parses of loaded ones.
export function grammarKeysForExts(exts: Iterable<string>): string[] {
  const keys = new Set<string>();
  for (const ext of exts) {
    for (const key of EMBEDDED_GRAMMARS[ext] ?? []) keys.add(key);
    const key = EXT_GRAMMAR[ext];
    if (key !== undefined) keys.add(key);
    // A `.h` may be parsed as C++ (grammarKeyFor). Leaving cpp cold in a repo
    // with no .cpp would send those headers to the C grammar instead, making the
    // output depend on which OTHER files the repo has.
    if (ext === ".h") keys.add("cpp");
  }
  return [...keys].sort();
}

export function grammarReady(key: string): boolean {
  return loaded.has(key);
}

// The loaded Language object for a grammar key, or undefined when it is not
// loaded. Needed to COMPILE a query against the same grammar that parsed the
// tree (src/ast/tags.ts); extraction itself never needs it.
export function languageFor(key: string): Language | undefined {
  return loaded.get(key);
}

// The shared parser, with `key`'s grammar selected. Returns null when the grammar
// is not loaded (caller uses the regex extractor). Sync — parse happens after.
export function parserFor(key: string): Parser | null {
  const lang = loaded.get(key);
  if (!parser || !lang) return null;
  parser.setLanguage(lang);
  return parser;
}
