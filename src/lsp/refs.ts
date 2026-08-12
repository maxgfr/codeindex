// Where an LSP answer meets the static one.
//
// ANNOTATE, NEVER REPLACE. `defs`, `callSites` and `referencingFiles` come back
// byte-identical whether or not a language server ran; the LSP answer arrives
// as an additive `lsp` block. Two reasons, both concrete:
//
//   * `staticOnly` is the ONLY evidence the static tier over-reported — the
//     homonym, the thing a type-aware answer is supposed to catch. A replace
//     merge deletes exactly the finding that justifies running the tier.
//   * A language server that has not finished indexing returns a PARTIAL answer
//     with no error and no flag. Replace would silently lose recall with
//     nothing to detect it by; union plus disagreement makes it visible.
//
// So the product is the agreement matrix, not a merged list.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoScan } from "../scan.js";
import type { SymbolReferences } from "../query.js";
import { byStr } from "../sort.js";
import type { LspSession } from "./client.js";
import type { LspRef } from "./protocol.js";

export interface LspAgreement {
  /** Files both tiers report — corroborated by two independent methods. */
  both: string[];
  /** Files only the language server found — the static tier under-recalled. */
  lspOnly: string[];
  /** Files only the static tier found — where the homonyms are. */
  staticOnly: string[];
}

export interface LspBlock {
  server: string;
  ok: boolean;
  /** Why it could not answer. Present only when `ok` is false. */
  reason?: string;
  refs: LspRef[];
  agreement: LspAgreement;
}

export interface LspReferences extends SymbolReferences {
  lsp?: LspBlock;
}

/** An `lsp` block for a tier that could not run, with the reason named. */
export function lspUnavailable(server: string, reason: string): LspBlock {
  return { server, ok: false, reason, refs: [], agreement: { both: [], lspOnly: [], staticOnly: [] } };
}

/**
 * A symbol's column on its declaration line.
 *
 * CodeSymbol carries `line`/`endLine` and no column (src/types.ts), because a
 * column is worth nothing to any other consumer and persisting one would widen
 * every artifact. LSP needs `{line, character}`, so it is derived HERE, from
 * the source, and never stored.
 *
 * Returns 0 when the name is not on that line — a position a server will simply
 * find no references for, which is the right failure: an empty LSP answer that
 * leaves the static tiers untouched.
 */
export function columnOfSymbol(root: string, rel: string, line: number, name: string): number {
  try {
    const lines = readFileSync(join(root, rel), "utf8").split(/\r?\n/);
    const index = lines[line - 1]?.indexOf(name) ?? -1;
    return index < 0 ? 0 : index;
  } catch {
    return 0;
  }
}

/** Cross the two answers into the agreement matrix, deterministically. */
export function agreementOf(refs: LspRef[], statik: SymbolReferences): LspAgreement {
  const lspFiles = new Set(refs.map((r) => r.file));
  const staticFiles = new Set<string>([
    ...statik.callSites.map((c) => c.file),
    ...statik.referencingFiles,
    // Declaration sites are references in the LSP sense (includeDeclaration),
    // so counting them keeps the two sides comparing the same population.
    ...statik.defs.map((d) => d.file),
  ]);

  const both: string[] = [];
  const lspOnly: string[] = [];
  const staticOnly: string[] = [];
  for (const file of lspFiles) (staticFiles.has(file) ? both : lspOnly).push(file);
  for (const file of staticFiles) if (!lspFiles.has(file)) staticOnly.push(file);

  return { both: both.sort(byStr), lspOnly: lspOnly.sort(byStr), staticOnly: staticOnly.sort(byStr) };
}

/**
 * Ask the language server about every declaration site the static tier found,
 * and annotate the static answer with what it said.
 *
 * Driven from the STATIC defs rather than from a workspace symbol query: those
 * are the positions this engine already knows are declarations, and it keeps
 * the two tiers answering about the same symbol rather than about two things
 * that happen to share a name.
 */
export async function annotateWithLsp(
  scan: RepoScan,
  name: string,
  statik: SymbolReferences,
  session: LspSession,
  serverId: string,
  languageId: string,
): Promise<LspReferences> {
  if (!session.capabilities.references) {
    return { ...statik, lsp: lspUnavailable(serverId, "server does not provide textDocument/references") };
  }
  if (!statik.defs.length) {
    return { ...statik, lsp: lspUnavailable(serverId, `no declaration of ${name} to anchor a request on`) };
  }

  const seen = new Set<string>();
  const refs: LspRef[] = [];
  try {
    for (const def of statik.defs) {
      const text = readTextOrEmpty(scan.root, def.file);
      if (!text) continue;
      session.didOpen(def.file, text, languageId);
      const character = columnOfSymbol(scan.root, def.file, def.line, name);
      for (const ref of await session.references(def.file, def.line, character)) {
        const key = `${ref.file}:${ref.line}:${ref.character ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push(ref);
      }
    }
  } catch (e) {
    // A timeout or a dead server mid-walk. Report what the failure was and keep
    // whatever it managed to say — partial evidence labelled as partial beats
    // discarding it, and the static answer is untouched either way.
    return {
      ...statik,
      lsp: {
        server: serverId,
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
        refs: refs.sort(refOrder),
        agreement: agreementOf(refs, statik),
      },
    };
  }

  refs.sort(refOrder);
  return { ...statik, lsp: { server: serverId, ok: true, refs, agreement: agreementOf(refs, statik) } };
}

function refOrder(a: LspRef, b: LspRef): number {
  return byStr(a.file, b.file) || a.line - b.line || (a.character ?? 0) - (b.character ?? 0);
}

function readTextOrEmpty(root: string, rel: string): string {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return "";
  }
}
