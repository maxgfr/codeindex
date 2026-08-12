// The ONLY file in the LSP tier that touches node:child_process.
//
// Isolated on purpose: every other module here is a pure state machine over an
// injected transport, so the untestable part of the system — a real process
// that may not exist, may hang, may die — is one small file with one exported
// function, and the browser build's shim only has to satisfy this much surface.
//
// Absence is reported the way the rest of the engine reports it (util.ts:sh,
// grep.ts, git.ts): `undefined`, not a throw. A configured language server that
// is not installed must cost the caller its static answer and nothing more.

import { spawn } from "node:child_process";
import type { LspTransport } from "./client.js";
import type { LspServerConfig } from "./config.js";

export function spawnLspTransport(server: LspServerConfig, cwd: string): LspTransport | undefined {
  let child;
  try {
    child = spawn(server.command, server.args ?? [], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(server.env ? { env: { ...process.env, ...server.env } } : {}),
    });
  } catch {
    // Thrown synchronously on some platforms for a malformed command.
    return undefined;
  }

  let exited = false;
  const dataListeners: ((chunk: Uint8Array | string) => void)[] = [];
  const exitListeners: ((code: number | null) => void)[] = [];

  const fireExit = (code: number | null): void => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener(code);
  };

  // ENOENT arrives asynchronously, as an `error` event on a child object that
  // has ALREADY been returned — which is why absence cannot be detected by a
  // try/catch and has to travel through onExit like any other death.
  child.on("error", () => fireExit(null));
  child.on("close", (code: number | null) => fireExit(code));

  child.stdout?.on("data", (chunk: unknown) => {
    for (const listener of dataListeners) listener(chunk as Uint8Array);
  });
  // stderr is drained and discarded. A language server writes progress and
  // warnings there continuously; leaving the pipe unread fills its buffer and
  // deadlocks the process it belongs to.
  child.stderr?.on("data", () => {});

  return {
    write(chunk) {
      if (exited) return;
      try {
        child.stdin?.write(chunk);
      } catch {
        // EPIPE: the server died between our check and this write.
        fireExit(null);
      }
    },
    onData(cb) {
      dataListeners.push(cb);
    },
    onExit(cb) {
      if (exited) cb(null);
      else exitListeners.push(cb);
    },
    close() {
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      // Politeness has a deadline. `shutdown`/`exit` were already sent by the
      // session; if the process is still alive shortly after, it is hung.
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already reaped */
        }
      }, 2000);
      timer.unref?.();
      child.on("close", () => clearTimeout(timer));
    },
  };
}
