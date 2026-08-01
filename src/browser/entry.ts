// Entry point of the browser bundle.
//
// It is deliberately three lines of substance: `export *` from the ONE public
// barrel, plus the VFS mount API the playground needs to feed it. There is no
// second, hand-maintained list of exports to drift out of sync with
// src/engine.ts — the browser build offers exactly the library surface the Node
// build does, minus nothing.
//
// Everything Node-specific is handled at the module-resolution layer (see the
// `browser` target in tsup.config.ts), not here and not in the engine source:
// node:fs becomes the in-memory VFS, node:crypto a synchronous SHA-1, and the
// spawn-based helpers report their binaries as missing so git.ts, grep.ts and
// pool.ts take the fallback paths they already ship and already test.

export * from "../engine.js";

// The VFS mount API — how the playground gets a repo in front of walk().
// Phase A mounts a manifest (paths + sizes, no bytes) so walk() can decide what
// is worth downloading; phase B attaches the bytes of what it kept.
export { resetVfs, mountFiles, setFileBytes, hasFileBytes, residentBytes, pruneUnfetched } from "./fs.js";
export type { MountedFile } from "./fs.js";

// Grammars. `loadGrammars(exts, fetchWasm)` is the one call most consumers
// want: it picks the minimal key set for the extensions present, fetches each
// through your transport, mounts them in the right order, and reports the tier
// actually achieved. The lower-level mounts are exported for anyone who needs
// to drive it by hand.
export { loadGrammars, mountRuntime, mountGrammar, grammarWasmName, GRAMMARS_DIR, RUNTIME_WASM } from "./grammars.js";
export type { GrammarLoad } from "./grammars.js";
