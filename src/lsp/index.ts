// The LSP tier's front door: status, and one call that answers references with
// a language server when one is configured and reachable.
//
// Degradation is the contract, not a fallback. Absent config, absent binary,
// absent capability, crash, timeout — every one of them returns the static
// answer with a NAMED reason and exit code 0. The tier can only ever add a
// labelled block; it can never subtract an answer.

import type { RepoScan } from "../scan.js";
import { findSymbol, type SymbolReferences } from "../query.js";
import { have } from "../util.js";
import { openLspSession, type LspCapabilities, type LspSession } from "./client.js";
import {
  loadLspConfig,
  resolveLspConfigPath,
  serverForLang,
  startupTimeoutFor,
  timeoutFor,
  type LspConfig,
  type LspConfigSource,
  type LspServerConfig,
} from "./config.js";
import { agreementOf, annotateWithLsp, lspUnavailable, type LspReferences } from "./refs.js";
import { spawnLspTransport } from "./spawn.js";
import { callersAgreement, callersUnavailable, collectIncomingCalls, type LspCallers } from "./callers.js";
import { uniqueIncomingCalls, type LspIncomingCall, type LspRef } from "./protocol.js";
import type { CodeSymbol } from "../types.js";

export type { LspConfig, LspServerConfig } from "./config.js";
export type { LspReferences, LspBlock, LspAgreement } from "./refs.js";
export type { LspRef, LspIncomingCall } from "./protocol.js";
export type { LspCallers, LspCallersBlock } from "./callers.js";

export interface LspServerStatus {
  id: string;
  languages: string[];
  command: string;
  /** `have(command)` — resolvable on PATH. No spawn. */
  onPath: boolean;
  /** Files in this scan whose language this server claims. */
  filesInRepo: number;
  /** --probe only: did `initialize` succeed, and what did it advertise. */
  reachable?: boolean;
  capabilities?: LspCapabilities;
  error?: string;
}

export interface LspStatus {
  lspVersion: 1;
  mode: "none" | "configured";
  configPath: string | null;
  source: LspConfigSource;
  servers: LspServerStatus[];
  /** Languages present in the repo that no configured server claims. */
  unmappedLanguages: string[];
}

/**
 * What the tier would do, without doing it.
 *
 * The default answer is cheap and spawns NOTHING: config, `have()`, and file
 * counts. `probe` is the part that starts each server to read its real
 * capabilities — the analogue of `probeEndpoint` in `embed status`, and like it,
 * the only part that touches the outside world.
 */
export async function lspStatus(scan: RepoScan, repo: string, probe = false): Promise<LspStatus> {
  const { path, source } = resolveLspConfigPath(repo);
  const config = loadLspConfig(repo); // throws only on a malformed file — see loadLspConfig
  if (!config) return { lspVersion: 1, mode: "none", configPath: path ?? null, source, servers: [], unmappedLanguages: [] };

  const counts = new Map<string, number>();
  for (const file of scan.files) counts.set(file.lang, (counts.get(file.lang) ?? 0) + 1);

  const servers: LspServerStatus[] = [];
  for (const server of config.servers) {
    const status: LspServerStatus = {
      id: server.id,
      languages: server.languages,
      command: server.command,
      onPath: have(server.command),
      filesInRepo: server.languages.reduce((sum, lang) => sum + (counts.get(lang) ?? 0), 0),
    };
    if (probe) {
      const session = await tryOpen(server, scan.root);
      if (session.ok) {
        status.reachable = true;
        status.capabilities = session.session.capabilities;
        await session.session.shutdown();
      } else {
        status.reachable = false;
        status.error = session.reason;
      }
    }
    servers.push(status);
  }

  const claimed = new Set(config.servers.flatMap((s) => s.languages));
  const unmappedLanguages = [...counts.keys()].filter((lang) => !claimed.has(lang) && lang !== "other").sort();

  return { lspVersion: 1, mode: "configured", configPath: path ?? null, source, servers, unmappedLanguages };
}

type OpenResult = { ok: true; session: LspSession } | { ok: false; reason: string };

async function tryOpen(server: LspServerConfig, root: string): Promise<OpenResult> {
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
    return { ok: true, session };
  } catch (e) {
    transport.close();
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `findReferences`, annotated by a language server when one can answer.
 *
 * The caller passes the static answer in, so this function CANNOT change it —
 * a structural guarantee rather than a promise. The server is chosen by the
 * language of the declarations that were found, which is why a repo with a
 * TypeScript server configured still gets its Go references answered
 * statically, silently and correctly.
 */
export async function referencesWithLsp(
  scan: RepoScan,
  repo: string,
  name: string,
  statik: SymbolReferences,
): Promise<LspReferences> {
  let config: LspConfig | undefined;
  try {
    config = loadLspConfig(repo);
  } catch (e) {
    // A malformed config is worth saying out loud, but not worth failing a read
    // command over: the static answer is still correct and complete.
    return { ...statik, lsp: lspUnavailable("(config)", e instanceof Error ? e.message : String(e)) };
  }
  if (!config) return statik; // tier not asked for — no block at all, byte-compat

  if (!statik.defs.length) return { ...statik, lsp: lspUnavailable("(none)", `no declaration of ${name} to anchor a request on`) };
  const { groups, reasons } = declarationServers(config, statik.defs);
  const refs: LspRef[] = [];
  for (const [server, defs] of groups) {
    const opened = await tryOpen(server, scan.root);
    if (!opened.ok) {
      reasons.push(`${server.id}: ${opened.reason}`);
      continue;
    }
    try {
      const answer = await annotateWithLsp(scan, name, { ...statik, defs }, opened.session, server.id, server.languageId);
      if (answer.lsp) {
        refs.push(...answer.lsp.refs);
        if (!answer.lsp.ok) reasons.push(`${server.id}: ${answer.lsp.reason ?? "request failed"}`);
      }
    } finally {
      await opened.session.shutdown();
    }
  }
  const seen = new Set<string>();
  const normalized = refs.filter((ref) => {
    const key = JSON.stringify([ref.file, ref.line, ref.character]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.character ?? 0) - (b.character ?? 0));
  return {
    ...statik,
    lsp: {
      server: [...groups.keys()].map((server) => server.id).sort().join(", ") || "(none)",
      ok: reasons.length === 0,
      ...(reasons.length ? { reason: [...new Set(reasons)].sort().join("; ") } : {}),
      refs: normalized,
      agreement: agreementOf(normalized, statik),
    },
  };
}

/** Incoming calls may exist even when the static caller index has no entry. */
export async function callersWithLsp<T extends object>(
  scan: RepoScan,
  repo: string,
  name: string,
  statik: T,
): Promise<LspCallers<T>> {
  let config: LspConfig | undefined;
  try {
    config = loadLspConfig(repo);
  } catch (error) {
    return { ...statik, lsp: callersUnavailable("(config)", error instanceof Error ? error.message : String(error)) };
  }
  if (!config) return { ...statik, lsp: callersUnavailable("(none)", "no LSP server configured") };

  const separator = name.indexOf("@");
  const target = separator < 0 ? name : name.slice(0, separator);
  const file = separator < 0 ? undefined : name.slice(separator + 1);
  const defs = findSymbol(scan, target, { maxResults: Infinity }).filter((def) => file === undefined || def.file === file);
  if (!defs.length) return { ...statik, lsp: callersUnavailable("(none)", `no declaration of ${name} to anchor a request on`) };

  const { groups, reasons } = declarationServers(config, defs);
  const calls: LspIncomingCall[] = [];
  for (const [server, declarations] of groups) {
    const opened = await tryOpen(server, scan.root);
    if (!opened.ok) {
      reasons.push(`${server.id}: ${opened.reason}`);
      continue;
    }
    try {
      const result = await collectIncomingCalls(scan, declarations, opened.session, server.languageId);
      calls.push(...result.calls);
      if (result.reason) reasons.push(`${server.id}: ${result.reason}`);
    } finally {
      await opened.session.shutdown();
    }
  }
  const normalized = uniqueIncomingCalls(calls);
  return {
    ...statik,
    lsp: {
      server: [...groups.keys()].map((server) => server.id).sort().join(", ") || "(none)",
      ok: reasons.length === 0,
      ...(reasons.length ? { reason: [...new Set(reasons)].sort().join("; ") } : {}),
      calls: normalized,
      agreement: callersAgreement(normalized, statik),
    },
  };
}

/** Group before opening a server: a homonym may belong to several languages. */
function declarationServers(config: LspConfig, defs: CodeSymbol[]): {
  groups: Map<LspServerConfig, CodeSymbol[]>;
  reasons: string[];
} {
  const groups = new Map<LspServerConfig, CodeSymbol[]>();
  const reasons: string[] = [];
  for (const def of defs) {
    const server = serverForLang(config, def.lang);
    if (!server) {
      reasons.push(`no server configured for ${def.lang}`);
      continue;
    }
    const group = groups.get(server) ?? [];
    group.push(def);
    groups.set(server, group);
  }
  return { groups, reasons };
}
