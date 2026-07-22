import { ensureGrammars, allGrammarKeys } from "../src/ast/loader.js";

// Warm every committed grammar before the test file is imported (setupFiles are
// awaited first), so scanRepo / extractCode exercise the SAME AST path the CLI
// uses — including any extraction a suite performs at module/describe scope
// (which runs before beforeAll). Without this the engine would silently fall
// back to regex under test while the shipped bundle used tree-sitter. Top-level
// await; idempotent and cached in-process, so it costs one wasm load per worker.
await ensureGrammars(allGrammarKeys());
