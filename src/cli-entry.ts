// Standalone CLI/MCP entry — built to scripts/cli.mjs with the engine left
// EXTERNAL (it imports the sibling scripts/engine.mjs at runtime instead of
// inlining a second copy). Kept separate from engine.mjs ON PURPOSE: the
// engine bundle is a pure side-effect-free library so consumers can inline it
// into their own single-file CLIs — a main-module guard inside it would
// misfire there and hijack their argv.
//   node scripts/cli.mjs graph --repo .
//   node scripts/cli.mjs mcp
import { runCli } from "./engine.js";

// A reader that closes the pipe early (`codeindex symbols | head`) is not an
// error of ours: stop quietly, as a Unix tool does, instead of an unhandled
// 'error' event and its stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });
}

try {
  await runCli(process.argv.slice(2));
} catch (e) {
  console.error(`codeindex: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
