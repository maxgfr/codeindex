// The LSP tier's front door: status, and one call that answers references with
// a language server when one is configured and reachable.
//
// Degradation is the contract, not a fallback. Absent config, absent binary,
// absent capability, crash, timeout — every one of them returns the static
// answer with a NAMED reason and exit code 0. The tier can only ever add a
// labelled block; it can never subtract an answer.

import type { RepoScan } from "../scan.js";
import type { SymbolReferences } from "../query.js";
import { have } from "../util.js";
import { openLspSession, type LspSession } from "./client.js";
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
import { annotateWithLsp, lspUnavailable, type LspReferences } from "./refs.js";
import { spawnLspTransport } from "./spawn.js";

export type { LspConfig, LspServerConfig } from "./config.js";
export type { LspReferences, LspBlock, LspAgreement } from "./refs.js";
export type { LspRef } from "./protocol.js";

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
  capabilities?: { references: boolean; definition: boolean; implementation: boolean; typeHierarchy: boolean };
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

  const lang = statik.defs[0]?.lang;
  if (!lang) return { ...statik, lsp: lspUnavailable("(none)", `no declaration of ${name} to anchor a request on`) };

  const server = serverForLang(config, lang);
  if (!server) return { ...statik, lsp: lspUnavailable("(none)", `no server configured for ${lang}`) };

  const opened = await tryOpen(server, scan.root);
  if (!opened.ok) return { ...statik, lsp: lspUnavailable(server.id, opened.reason) };

  try {
    return await annotateWithLsp(scan, name, statik, opened.session, server.id, server.languageId ?? server.languages[0]!);
  } finally {
    await opened.session.shutdown();
  }
}
