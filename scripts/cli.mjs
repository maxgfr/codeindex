#!/usr/bin/env node

// src/cli-entry.ts
import { runCli } from "./engine.mjs";
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}
try {
  await runCli(process.argv.slice(2));
} catch (e) {
  console.error(`codeindex: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
