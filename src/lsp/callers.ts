// The call hierarchy adds typed evidence to an unchanged static answer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeSymbol } from "../types.js";
import type { RepoScan } from "../scan.js";
import { byStr } from "../sort.js";
import { LspIncomingCallsError, type LspSession } from "./client.js";
import { uniqueIncomingCalls, type LspIncomingCall } from "./protocol.js";
import { columnOfSymbol, type LspAgreement } from "./refs.js";

export interface LspCallersBlock {
  server: string;
  ok: boolean;
  reason?: string;
  calls: LspIncomingCall[];
  agreement: LspAgreement;
}

export type LspCallers<T extends object> = T & { lsp?: LspCallersBlock };

/** Compare call-site files only; declarations are not incoming calls. */
export function callersAgreement(calls: LspIncomingCall[], statik: object): LspAgreement {
  const sites: unknown = "callers" in statik ? statik.callers : undefined;
  const staticFiles = new Set<string>();
  if (Array.isArray(sites)) {
    for (const site of sites) if (site && typeof site.file === "string") staticFiles.add(site.file);
  }
  const lspFiles = new Set(calls.map((call) => call.file));
  return {
    both: [...lspFiles].filter((file) => staticFiles.has(file)).sort(byStr),
    lspOnly: [...lspFiles].filter((file) => !staticFiles.has(file)).sort(byStr),
    staticOnly: [...staticFiles].filter((file) => !lspFiles.has(file)).sort(byStr),
  };
}

export function callersUnavailable(server: string, reason: string): LspCallersBlock {
  return { server, ok: false, reason, calls: [], agreement: { both: [], lspOnly: [], staticOnly: [] } };
}

/** Read declaration positions without adding columns to persisted artifacts. */
export async function collectIncomingCalls(
  scan: RepoScan,
  defs: CodeSymbol[],
  session: LspSession,
  languageId?: string,
): Promise<{ calls: LspIncomingCall[]; reason?: string }> {
  const calls: LspIncomingCall[] = [];
  if (!session.capabilities.callHierarchy) return { calls, reason: "server does not provide textDocument/prepareCallHierarchy" };
  try {
    for (const def of defs) {
      const text = readFileSync(join(scan.root, def.file), "utf8");
      session.didOpen(def.file, text, languageId ?? def.lang);
      calls.push(...await session.incomingCalls(def.file, def.line, columnOfSymbol(scan.root, def.file, def.line, def.name)));
    }
    return { calls: uniqueIncomingCalls(calls) };
  } catch (error) {
    if (error instanceof LspIncomingCallsError) calls.push(...error.calls);
    return { calls: uniqueIncomingCalls(calls), reason: error instanceof Error ? error.message : String(error) };
  }
}
