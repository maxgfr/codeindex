// Minimal newline-delimited JSON-RPC 2.0 stdio client for MCP servers.
//
// Total by construction: every operation resolves a value — {ok:false, reason}
// on any failure (spawn error, server exit, rpc error, timeout) and NEVER
// throws or rejects. The stderr of the child is buffered (tail-capped) so
// failure reasons can carry the server's own complaint. Used by mcp-probe.mjs,
// which runs as a child of the bench orchestrator; the orchestrator itself
// stays synchronous and never imports this module.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_TIMEOUT_MS = 120_000;
const STDERR_CAP = 64 * 1024; // keep only the tail — enough for a reason string
const REASON_SNIP = 300;

const snip = (s) => {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  return t.length > REASON_SNIP ? `${t.slice(0, REASON_SNIP)}…` : t;
};

// Spawn an MCP stdio server and return a client handle. Never throws: a spawn
// failure surfaces as {ok:false, reason} on the first (and every) request.
export function startMcpClient(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let child;
  let dead = false;
  let deadReason = "";
  let stderrBuf = "";
  let nextId = 1;
  const pending = new Map(); // id -> { settle, timer }

  const die = (reason) => {
    if (dead) return;
    dead = true;
    deadReason = reason;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.settle({ ok: false, reason });
    }
    pending.clear();
  };

  const stderrTail = () => (stderrBuf ? ` — stderr: ${snip(stderrBuf)}` : "");

  try {
    child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    die(`spawn failed: ${e?.message ?? e}`);
  }

  if (child) {
    child.on("error", (e) => die(`spawn failed: ${e?.message ?? e}`));
    child.on("exit", (code, signal) => {
      die(`server exited (${signal ?? `code ${code}`})${stderrTail()}`);
    });
    child.stderr.on("data", (d) => {
      stderrBuf = (stderrBuf + d).slice(-STDERR_CAP);
    });
    // One JSON message per stdout line; non-JSON lines (stray logs) are skipped.
    const rl = createInterface({ input: child.stdout, terminal: false });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let msg;
      try { msg = JSON.parse(t); } catch { return; }
      const p = msg && msg.id !== undefined && msg.id !== null ? pending.get(msg.id) : undefined;
      if (!p) return; // notification / unknown id — not ours to settle
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.settle({ ok: false, reason: `rpc error ${msg.error.code}: ${snip(msg.error.message)}` });
      else p.settle({ ok: true, result: msg.result });
    });
  }

  // Single-line writes only — the framing IS the newline.
  const writeLine = (obj) => {
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch (e) {
      die(`stdin write failed: ${e?.message ?? e}`);
      return false;
    }
  };

  return {
    get alive() { return !dead; },
    stderrText() { return stderrBuf; },

    // Resolves {ok:true, result} | {ok:false, reason}. Per-request timeout.
    request(method, params) {
      return new Promise((settle) => {
        if (dead) return settle({ ok: false, reason: deadReason });
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          settle({ ok: false, reason: `timeout after ${timeoutMs}ms: ${method}${stderrTail()}` });
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { settle, timer });
        if (!writeLine({ jsonrpc: "2.0", id, method, params })) {
          pending.delete(id);
          clearTimeout(timer);
          settle({ ok: false, reason: deadReason });
        }
      });
    },

    // Fire-and-forget notification (no id, no response expected).
    notify(method, params) {
      if (!dead) writeLine({ jsonrpc: "2.0", method, params });
    },

    // MCP handshake: initialize -> await -> notifications/initialized.
    async handshake() {
      const init = await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "codeindex-bench", version: "0" },
      });
      if (!init.ok) return init;
      this.notify("notifications/initialized", {});
      return { ok: true, serverInfo: init.result?.serverInfo };
    },

    // Kill the child; resolves once it is gone (SIGKILL fallback after 2s).
    close() {
      return new Promise((settle) => {
        if (!child || child.exitCode !== null || child.signalCode !== null) {
          die("closed");
          return settle();
        }
        const hard = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 2_000);
        hard.unref?.();
        child.once("exit", () => { clearTimeout(hard); settle(); });
        die("closed");
        try { child.kill(); } catch { clearTimeout(hard); settle(); }
      });
    },
  };
}
