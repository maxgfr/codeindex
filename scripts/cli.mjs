#!/usr/bin/env node
// Standalone CLI/MCP entry for the codeindex engine. Kept as a separate static
// wrapper ON PURPOSE: engine.mjs is a pure side-effect-free library so that
// consumers can inline it into their own single-file CLIs — a main-module
// guard inside the bundle would misfire there and hijack their argv.
//   node scripts/cli.mjs graph --repo .
//   node scripts/cli.mjs mcp
import { runCli } from "./engine.mjs";

await runCli(process.argv.slice(2));
