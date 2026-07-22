#!/usr/bin/env node

// src/cli-entry.ts
import { runCli } from "./engine.mjs";
try {
  await runCli(process.argv.slice(2));
} catch (e) {
  console.error(`codeindex: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
