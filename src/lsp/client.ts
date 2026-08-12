// A minimal LSP client: request/response correlation, timeouts, capability
// gating, orderly shutdown.
//
// The transport is INJECTED. Nothing in this file knows what a process is, so
// the whole state machine — a reply arriving after its timeout, a server that
// dies mid-request, a server that answers `initialize` without advertising
// references — is tested against an in-memory transport with a controllable
// clock, and not against a language server that CI would have to install.
//
// Deliberately not a general LSP client. It speaks the four requests the
// reference tier needs and refuses to grow a document-sync model: this engine
// does not own the user's buffers, so it opens files read-only and never sends
// didChange. Anything richer belongs in an editor, not in an indexer.

import { createFramer, encodeMessage, fileUri, locationsToRefs, type LspMessage, type LspRef } from "./protocol.js";

export interface LspTransport {
  write(chunk: string): void;
  onData(cb: (chunk: Uint8Array | string) => void): void;
  /** Fired when the far side goes away, however it went away. */
  onExit(cb: (code: number | null) => void): void;
  close(): void;
}

export interface LspSessionOptions {
  /** Absolute repository root; every URI is built against it. */
  root: string;
  timeoutMs?: number;
  startupTimeoutMs?: number;
  initializationOptions?: unknown;
}

export interface LspCapabilities {
  references: boolean;
  definition: boolean;
  implementation: boolean;
  typeHierarchy: boolean;
}

export interface LspSession {
  readonly capabilities: LspCapabilities;
  didOpen(rel: string, text: string, languageId: string): void;
  references(rel: string, line: number, character: number): Promise<LspRef[]>;
  definition(rel: string, line: number, character: number): Promise<LspRef[]>;
  shutdown(): Promise<void>;
}

/** Thrown when a request outlives its budget. Named so callers can tell it apart. */
export class LspTimeout extends Error {
  constructor(method: string, ms: number) {
    super(`${method} exceeded ${ms}ms`);
    this.name = "LspTimeout";
  }
}

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_STARTUP_TIMEOUT = 15000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export async function openLspSession(transport: LspTransport, options: LspSessionOptions): Promise<LspSession> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT;

  const framer = createFramer();
  const pending = new Map<number, Pending>();
  const open = new Set<string>();
  let nextId = 1;
  let dead: Error | undefined;

  const failAll = (error: Error): void => {
    dead = error;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  transport.onData((chunk) => {
    for (const message of framer.push(chunk)) {
      // Server-initiated requests and notifications (progress, diagnostics,
      // window/logMessage) are simply ignored. This client asks questions; it
      // does not host a language server's UI, and a server that gets no answer
      // to `window/showMessageRequest` carries on.
      if (typeof message.id !== "number") continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue; // a reply that arrived after its timeout
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`${message.error.message} (code ${message.error.code})`));
      else waiter.resolve(message.result);
    }
  });

  transport.onExit((code) => failAll(new Error(`language server exited (code ${code ?? "unknown"})`)));

  const notify = (method: string, params: unknown): void => {
    if (dead) return;
    transport.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  };

  const request = (method: string, params: unknown, budget = timeoutMs): Promise<unknown> => {
    if (dead) return Promise.reject(dead);
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop the waiter but keep the SESSION: one slow request (a server
        // still warming its index) must not poison the ones after it.
        pending.delete(id);
        reject(new LspTimeout(method, budget));
      }, budget);
      // Node keeps the event loop alive for a pending timer; a CLI that has
      // already printed its answer should not hang on one.
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      transport.write(encodeMessage({ jsonrpc: "2.0", id, method, params } satisfies LspMessage));
    });
  };

  const initResult = (await request(
    "initialize",
    {
      processId: null,
      rootUri: fileUri(options.root, ""),
      workspaceFolders: [{ uri: fileUri(options.root, ""), name: "repo" }],
      capabilities: {
        textDocument: {
          references: { dynamicRegistration: false },
          definition: { dynamicRegistration: false, linkSupport: true },
          implementation: { dynamicRegistration: false, linkSupport: true },
        },
      },
      ...(options.initializationOptions !== undefined ? { initializationOptions: options.initializationOptions } : {}),
    },
    startupTimeoutMs,
  )) as { capabilities?: Record<string, unknown> } | undefined;

  notify("initialized", {});

  // A provider may be advertised as `true` or as an options object; both mean
  // supported. Absent or false means the server cannot answer, and asking anyway
  // wastes a round trip to get an error back.
  const provides = (key: string): boolean => {
    const value = initResult?.capabilities?.[key];
    return value === true || (typeof value === "object" && value !== null);
  };

  const capabilities: LspCapabilities = {
    references: provides("referencesProvider"),
    definition: provides("definitionProvider"),
    implementation: provides("implementationProvider"),
    typeHierarchy: provides("typeHierarchyProvider"),
  };

  const positionOf = (rel: string, line: number, character: number): unknown => ({
    textDocument: { uri: fileUri(options.root, rel) },
    // The engine counts lines from 1; LSP counts from 0.
    position: { line: Math.max(0, line - 1), character },
  });

  return {
    capabilities,

    didOpen(rel, text, languageId) {
      if (open.has(rel)) return;
      open.add(rel);
      notify("textDocument/didOpen", {
        textDocument: { uri: fileUri(options.root, rel), languageId, version: 1, text },
      });
    },

    async references(rel, line, character) {
      if (!capabilities.references) return [];
      const raw = await request("textDocument/references", {
        ...(positionOf(rel, line, character) as object),
        context: { includeDeclaration: true },
      });
      return locationsToRefs(options.root, raw);
    },

    async definition(rel, line, character) {
      if (!capabilities.definition) return [];
      return locationsToRefs(options.root, await request("textDocument/definition", positionOf(rel, line, character)));
    },

    async shutdown() {
      try {
        for (const rel of open) notify("textDocument/didClose", { textDocument: { uri: fileUri(options.root, rel) } });
        open.clear();
        // Best-effort and short: a server that will not shut down politely gets
        // its transport closed under it, which is what close() is for.
        await request("shutdown", null, Math.min(timeoutMs, 2000));
        notify("exit", undefined);
      } catch {
        /* already gone, or refusing to answer — close() below is the backstop */
      } finally {
        failAll(new Error("session closed"));
        transport.close();
      }
    },
  };
}
