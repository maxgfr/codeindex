// Standalone CLI/MCP entry — built to scripts/cli.mjs with the engine left
// EXTERNAL (it imports the sibling scripts/engine.mjs at runtime instead of
// inlining a second copy). Kept separate from engine.mjs ON PURPOSE: the
// engine bundle is a pure side-effect-free library so consumers can inline it
// into their own single-file CLIs — a main-module guard inside it would
// misfire there and hijack their argv.
//   node scripts/cli.mjs graph --repo .
//   node scripts/cli.mjs mcp
import { runCli } from "./engine.js";

try {
  await runCli(process.argv.slice(2));
} catch (e) {
  console.error(`codeindex: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
