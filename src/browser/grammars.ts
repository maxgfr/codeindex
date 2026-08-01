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
