import { expect, it } from "vitest";
import { spawnLspTransport } from "../src/lsp/spawn.js";

it("reports a closed server input as transport failure without an uncaught stream error", async () => {
  // Keep the server alive after closing fd 0: the pipe fails before the child
  // emits close, reproducing the gap a synchronous write try/catch misses.
  const transport = spawnLspTransport({
    id: "closed-input", languages: ["typescript"], command: process.execPath,
    args: ["-e", 'require("node:fs").closeSync(0); process.stdout.write("ready"); setTimeout(() => {}, 5000);'],
  }, process.cwd())!;
  let exited = false;
  const failure = new Promise<void>((resolve) => transport.onExit(() => { exited = true; resolve(); }));
  try {
    await new Promise<void>((resolve) => transport.onData(() => resolve()));
    transport.write("x".repeat(1024 * 1024));
    await Promise.race([failure, new Promise((_, reject) => setTimeout(() => reject(new Error("closed stdin was not reported")), 1000))]);
    expect(exited).toBe(true);
    expect(() => transport.write("late write")).not.toThrow();
  } finally { transport.close(); }
}, 10_000);
