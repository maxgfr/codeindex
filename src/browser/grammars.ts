// Getting tree-sitter grammars in front of the AST tier, in a browser.
//
// ast/loader.ts needs no modification for this, because of an ordering it
// already has: resolveGrammarsTier checks CODEINDEX_GRAMMAR_DIR *first* and
// returns immediately when that directory exists (loader.ts:106-108) — before
// it ever reaches the module-relative probe that calls
// fileURLToPath(import.meta.url), which would throw on the https: URL a browser
// module has. So pointing that variable at a VFS directory is the whole
// integration.
//
// The other half is timing. ensureGrammars is async, but it reads the wasm with
// a SYNCHRONOUS readFileSync. Mounting the bytes must therefore complete before
// ensureGrammars is called — which is exactly what this module's contract says:
// mount first, then ensure. The caller already knows which grammars it needs
// without guessing, because grammarKeysForExts (also exported from the barrel)
// maps the walked extension set to the minimal key set.

import { setFileBytes } from "./fs.js";
import { ensureGrammars, grammarKeysForExts, grammarReady } from "../ast/loader.js";

/** Where the VFS holds grammar wasm. An implementation detail of this module. */
export const GRAMMARS_DIR = "/grammars";

/** The tree-sitter runtime itself, which must be mounted before any grammar. */
export const RUNTIME_WASM = "web-tree-sitter.wasm";

/**
 * Mount the tree-sitter runtime. Required before any grammar can load; without
 * it ensureGrammars returns early and every language falls to the regex tier.
 */
export function mountRuntime(bytes: Uint8Array): void {
  mountWasm(RUNTIME_WASM, bytes);
}

/**
 * Mount one grammar by its loader key ("typescript", "go", …) — the same keys
 * grammarKeysForExts returns. Call once per key, then `await ensureGrammars`.
 */
export function mountGrammar(key: string, bytes: Uint8Array): void {
  mountWasm(`${key}.wasm`, bytes);
}

function mountWasm(name: string, bytes: Uint8Array): void {
  setFileBytes(`${GRAMMARS_DIR}/${name}`, bytes);
  // Set on every mount rather than once at init: the directory has to EXIST for
  // resolveGrammarsTier's existsSync to accept it, and it only starts existing
  // when the first file lands in it.
  process.env.CODEINDEX_GRAMMAR_DIR = GRAMMARS_DIR;
}

/** The filename a grammar key maps to, for callers assembling fetch URLs. */
export function grammarWasmName(key: string): string {
  return `${key}.wasm`;
}

/** What the AST tier actually achieved — reported, never assumed. */
export interface GrammarLoad {
  /** "ast" when at least one grammar loaded, "regex" otherwise. */
  tier: "ast" | "regex";
  /** Grammar keys that are live and will be used for extraction. */
  loaded: string[];
  /** Keys that were needed but could not be loaded; those languages use regex. */
  failed: string[];
  /** A human-readable reason when something is degraded, else "". */
  note: string;
}

/**
 * Load exactly the grammars a set of file extensions needs, fetching each wasm
 * through the caller's own transport.
 *
 * This is the whole browser grammar dance in one call, and it is here rather
 * than in the playground because every browser consumer needs the identical
 * sequence: ask the engine which keys the extensions map to, fetch only those,
 * mount them before the synchronous readFileSync inside ensureGrammars runs,
 * and then find out which ones actually made it.
 *
 * `fetchWasm` receives a bare filename ("typescript.wasm", "web-tree-sitter.wasm")
 * and returns its bytes — leaving the caller in charge of where grammars are
 * hosted and whether they are cached. Throwing from it is fine: a grammar that
 * cannot be fetched is recorded in `failed` and its language falls back to the
 * regex tier, which is the engine's normal degradation and not an error.
 *
 * The RETURN VALUE MATTERS. A failed wasm fetch silently drops extraction to
 * the regex tier, and a UI that claims an AST tier it did not get is lying
 * about the thing that distinguishes it — so the achieved tier is returned
 * rather than inferred from the absence of an exception.
 */
export async function loadGrammars(exts: Iterable<string>, fetchWasm: (name: string) => Promise<Uint8Array>): Promise<GrammarLoad> {
  const keys = grammarKeysForExts(exts);
  if (!keys.length) {
    return { tier: "regex", loaded: [], failed: [], note: "no language here ships a tree-sitter grammar" };
  }

  try {
    mountRuntime(await fetchWasm(RUNTIME_WASM));
  } catch (error) {
    // Without the runtime no grammar can load at all, so this is the one
    // failure worth naming separately from a per-language one.
    return { tier: "regex", loaded: [], failed: [...keys], note: `tree-sitter runtime unavailable (${(error as Error).message})` };
  }

  await Promise.all(
    keys.map(async (key) => {
      try {
        mountGrammar(key, await fetchWasm(grammarWasmName(key)));
      } catch {
        // Left unmounted on purpose: ensureGrammars records it as failed and
        // that language uses the regex extractor.
      }
    }),
  );
  await ensureGrammars(keys);

  const loaded = keys.filter((key) => grammarReady(key)).sort();
  const failed = keys.filter((key) => !grammarReady(key)).sort();
  return {
    tier: loaded.length ? "ast" : "regex",
    loaded,
    failed,
    note: failed.length ? `${failed.join(", ")} could not load; those languages use the regex tier` : "",
  };
}
