// Language-server sessions kept alive across queries, for a long-lived host.
//
// A fresh session per query costs a spawn plus `initialize` (1-3 s on pyright
// or tsserver), and its first answer is often PARTIAL: pyright answers a
// `references` request that arrives right after `initialize` with the
// declaration alone, then with all eight sites 30 ms later. The MCP server
// therefore owns one pool for its lifetime. The CLI answers one question per
// process and opens a fresh session through the same `withLspSession` call,
// with no pool.
//
// Reuse is keyed on the server's full config and the repository root, and is
// valid only while the repository's non-doc content is the one the session was
// opened on. This client never sends didChange (see client.ts), so a changed
// tree is answered by a fresh server rather than by one that may hold stale
// buffers or a stale import graph. Doc files are left out of that stamp: an
// edited README tells no language server anything.
//
// No child outlives the host. A session closes after `idleMs` without use,
// `close()` shuts every one down when the host stops, `exit` and SIGINT/
// SIGTERM/SIGHUP hooks SIGKILL whatever is still alive when the process ends
// without calling it, and every server is told the host's pid (`processId`),
// which servers use to exit when their parent is SIGKILLed.

import { have } from "../util.js";
import { sha1 } from "../hash.js";
import type { RepoScan } from "../scan.js";
import { openLspSession, withServerError, type LspSession, type LspTransport } from "./client.js";
import { startupTimeoutFor, timeoutFor, type LspServerConfig } from "./config.js";
import { spawnLspTransport } from "./spawn.js";

export type OpenResult =
  | { ok: true; session: LspSession; transport: LspTransport }
  | { ok: false; reason: string };

/** Spawn a configured server and complete `initialize`, or say why not. */
export async function openServer(server: LspServerConfig, root: string): Promise<OpenResult> {
  if (!have(server.command)) return { ok: false, reason: `${server.command} is not on PATH` };
  const transport = spawnLspTransport(server, root);
  if (!transport) return { ok: false, reason: `could not start ${server.command}` };
  try {
    const session = await openLspSession(transport, {
      root,
      timeoutMs: timeoutFor(server),
      startupTimeoutMs: startupTimeoutFor(server),
      ...(server.initializationOptions !== undefined ? { initializationOptions: server.initializationOptions } : {}),
    });
    return { ok: true, session, transport };
  } catch (e) {
    transport.close();
    // An `initialize` timeout says nothing about why; the server's stderr may.
    return { ok: false, reason: withServerError(e instanceof Error ? e.message : String(e), transport) };
  }
}

/** What a query gets to work with, pooled or not. */
export interface LspLease {
  session: LspSession;
  /**
   * The session has already given an answer beyond bare declarations, so its
   * index is built: a declaration-only answer from it is believed rather than
   * retried as a server that is still warming up.
   */
  readonly warm: boolean;
  markWarm(): void;
}

export type LeaseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * The content a pooled session may answer for: every non-doc file and its
 * hash. `RepoScan` is re-proved fresh by the MCP session cache on every call,
 * so a changed stamp is exactly "a file the server may have read changed".
 */
export function scanStamp(scan: RepoScan): string {
  return sha1(scan.files.filter((f) => f.kind !== "doc").map((f) => `${f.rel}:${f.hash}`).join("\n"));
}

/**
 * Run `fn` against a session for `server`: a pooled one when `pool` is given,
 * otherwise a fresh one that is shut down before this returns.
 */
export async function withLspSession<T>(
  server: LspServerConfig,
  scan: RepoScan,
  pool: LspSessionPool | undefined,
  fn: (lease: LspLease) => Promise<T>,
): Promise<LeaseResult<T>> {
  if (pool) return pool.use(server, scan.root, scanStamp(scan), fn);
  const opened = await openServer(server, scan.root);
  if (!opened.ok) return opened;
  let warm = false;
  try {
    const value = await fn({ session: opened.session, get warm() { return warm; }, markWarm: () => { warm = true; } });
    return { ok: true, value };
  } finally {
    await opened.session.shutdown();
  }
}

export interface LspPoolOptions {
  /** Close a session after this long without a query, ms (default 5 min). */
  idleMs?: number;
  /** How a session is opened; tests inject one. */
  open?: (server: LspServerConfig, root: string) => Promise<OpenResult>;
}

interface Entry {
  identity: string;
  stamp: string;
  opening: Promise<OpenResult>;
  warm: boolean;
  busy: number;
  retired: boolean;
  idle?: ReturnType<typeof setTimeout>;
}

export const DEFAULT_IDLE_MS = 5 * 60_000;

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export class LspSessionPool {
  private readonly entries = new Map<string, Entry>();
  private readonly idleMs: number;
  private readonly open: (server: LspServerConfig, root: string) => Promise<OpenResult>;
  // Every transport this pool started and has not yet seen exit, retired or
  // not: the `exit` hook must reach a server that is mid-shutdown too.
  private readonly live = new Set<LspTransport>();
  private readonly killAll = (): void => {
    for (const transport of this.live) transport.kill?.();
  };
  private hooked = false;
  private closed = false;

  constructor(options: LspPoolOptions = {}) {
    this.idleMs = options.idleMs ?? idleFromEnv() ?? DEFAULT_IDLE_MS;
    this.open = options.open ?? openServer;
  }

  /** Live sessions, for tests and status. */
  get size(): number {
    return this.entries.size;
  }

  async use<T>(server: LspServerConfig, root: string, stamp: string, fn: (lease: LspLease) => Promise<T>): Promise<LeaseResult<T>> {
    const key = JSON.stringify([root, server.id]);
    // The whole config, not only the id: an edited lsp.json (new args, new
    // initializationOptions) must not be answered by the server it replaced.
    const identity = JSON.stringify(server);
    let entry = this.entries.get(key);
    if (entry && (entry.identity !== identity || entry.stamp !== stamp)) {
      this.retire(key, entry);
      entry = undefined;
    }
    let opened = entry ? await entry.opening : undefined;
    // A pooled server that died between queries (crash, OOM, killed by hand)
    // is replaced once, silently: the query never saw it.
    if (entry && opened?.ok && !opened.session.alive()) {
      this.retire(key, entry);
      entry = undefined;
    }
    if (!entry) {
      this.hook();
      const opening = this.open(server, root).then((result) => {
        if (result.ok) {
          this.live.add(result.transport);
          result.transport.onExit(() => {
            this.live.delete(result.transport);
            if (this.closed) this.unhook();
          });
        }
        return result;
      });
      entry = { identity, stamp, opening, warm: false, busy: 0, retired: false };
      this.entries.set(key, entry);
      opened = await entry.opening;
    }
    if (!opened?.ok) {
      // A failure is not cached: the binary may be installed, or the config
      // fixed, before the next query.
      if (this.entries.get(key) === entry) this.entries.delete(key);
      return { ok: false, reason: opened?.reason ?? "language server did not start" };
    }
    const current = entry;
    current.busy++;
    if (current.idle) clearTimeout(current.idle);
    current.idle = undefined;
    try {
      const value = await fn({ session: opened.session, get warm() { return current.warm; }, markWarm: () => { current.warm = true; } });
      return { ok: true, value };
    } finally {
      current.busy--;
      if (current.busy === 0) {
        if (current.retired) void this.shutdown(current);
        else {
          current.idle = setTimeout(() => this.retire(key, current), this.idleMs);
          // An idle language server must never be what keeps the host alive.
          current.idle.unref?.();
        }
      }
    }
  }

  /** Shut every session down. The host calls this when it stops. */
  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.closed = true;
    await Promise.all(entries.map((entry) => this.shutdown(entry)));
    this.unhook();
  }

  private retire(key: string, entry: Entry): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    entry.retired = true;
    if (entry.busy === 0) void this.shutdown(entry);
  }

  private async shutdown(entry: Entry): Promise<void> {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = undefined;
    const opened = await entry.opening;
    if (opened.ok) await opened.session.shutdown();
  }

  // A host stopped by a signal runs no `exit` hook and never reaches close().
  // Kill the servers, then let the signal do what it would have done: with our
  // listener gone and no other, re-raising it ends the process the default way.
  private readonly onSignal = (signal: NodeJS.Signals): void => {
    this.killAll();
    this.unhook(true);
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };

  private hook(): void {
    this.closed = false;
    if (this.hooked) return;
    this.hooked = true;
    process.on("exit", this.killAll);
    for (const signal of SIGNALS) process.on(signal, this.onSignal);
  }

  /** Drop the hooks once nothing they could kill is left. */
  private unhook(force = false): void {
    if (!this.hooked || (this.live.size && !force)) return;
    this.hooked = false;
    process.removeListener("exit", this.killAll);
    for (const signal of SIGNALS) process.removeListener(signal, this.onSignal);
  }
}

function idleFromEnv(): number | undefined {
  const raw = process.env.CODEINDEX_LSP_IDLE_MS;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
