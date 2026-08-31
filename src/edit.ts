// Symbolic editing over AST line spans (Serena-parity, static edition):
// replace a symbol's body, insert after/before a symbol — the range math and
// blank-line normalization mirror the market leader's contract, but resolved
// from the deterministic index instead of a live language server. Line-span
// granularity: the caller supplies the replacement body verbatim, including
// its indentation (same contract as Serena's replace_symbol_body).
import { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CodeSymbol } from "./types.js";
import type { RepoScan } from "./scan.js";
import { findSymbol } from "./query.js";

// Symbol kinds that conventionally sit separated from neighbours by a blank
// line — insertions next to them keep at least one.
const SEPARATED_KINDS = new Set(["function", "method", "class", "interface", "struct", "trait", "enum", "def"]);

export interface EditResult {
  file: string;
  startLine: number; // 1-based, inclusive — the lines the edit touched
  endLine: number;
  lines: number; // lines written
}

// Resolve a name path to exactly ONE symbol or throw with the candidate list
// (the agent then disambiguates with a more specific path — same contract as
// Serena's find_unique).
export function resolveUniqueSymbol(scan: RepoScan, namePath: string, file?: string): CodeSymbol {
  let matches = findSymbol(scan, namePath);
  if (file) matches = matches.filter((m) => m.file === file);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    const near = findSymbol(scan, namePath, { substring: true, maxResults: 5 })
      .map((m) => `${m.file}:${m.line} ${m.parent ? m.parent + "/" : ""}${m.name}`)
      .join(", ");
    throw new Error(`no symbol matches "${namePath}"${file ? ` in ${file}` : ""}${near ? ` — near matches: ${near}` : ""}`);
  }
  const list = matches.map((m) => `${m.file}:${m.line}`).join(", ");
  throw new Error(`"${namePath}" is ambiguous (${matches.length} matches: ${list}) — qualify with \`file\` or a Parent/name path`);
}

function readLines(abs: string): string[] {
  return readFileSync(abs, "utf8").split("\n");
}

// Write beside the resolved target and atomically rename over it where the
// platform permits. Symlinks stay symlinks because their real target is edited.
// As with every rename-based atomic replacement, the target receives a new
// inode (hard links/open descriptors keep the old one). Windows locks and
// file-writable/directory-read-only setups fall back to the historical in-place
// write rather than turning a valid edit into EPERM. A killed process can leave
// the hidden temp directory visible to git in a consumer repo; the scanner and
// MCP watcher always ignore the prefix so it cannot become a phantom symbol.
export function atomicWriteText(abs: string, content: string, cleanup: typeof rmSync = rmSync): void {
  const target = realpathSync(abs);
  const mode = statSync(target).mode;
  let tempDir: string;
  try {
    tempDir = mkdtempSync(join(dirname(target), ".codeindex-edit-"));
  } catch {
    writeFileSync(target, content);
    chmodSync(target, mode);
    return;
  }
  const tempFile = join(tempDir, basename(target));
  try {
    writeFileSync(tempFile, content);
    chmodSync(tempFile, mode);
    try {
      renameSync(tempFile, target);
    } catch {
      writeFileSync(target, content);
      chmodSync(target, mode);
    }
  } finally {
    // The target may already have been atomically replaced. Cleanup failure is
    // therefore not an edit failure: reporting it as one invites a retry that
    // can duplicate insert-before/after operations.
    try {
      cleanup(tempDir, { recursive: true, force: true });
    } catch {
      // The uniquely named orphan is harmless and can be removed later.
    }
  }
}

// Replace the symbol's whole declaration (lines start..endLine) with `body`.
// The body is taken verbatim after trimming outer blank lines — supply it
// fully indented for its context.
export function replaceSymbolBody(scan: RepoScan, namePath: string, body: string, file?: string): EditResult {
  const sym = resolveUniqueSymbol(scan, namePath, file);
  const end = sym.endLine ?? sym.line;
  const abs = join(scan.root, sym.file);
  const lines = readLines(abs);
  const newLines = body.replace(/^\n+|\n+$/g, "").split("\n");
  lines.splice(sym.line - 1, end - sym.line + 1, ...newLines);
  atomicWriteText(abs, lines.join("\n"));
  return { file: sym.file, startLine: sym.line, endLine: sym.line + newLines.length - 1, lines: newLines.length };
}

function insertAt(
  scan: RepoScan,
  sym: CodeSymbol,
  body: string,
  index: number, // 0-based line index to insert at
  blankBefore: boolean,
  blankAfter: boolean,
): EditResult {
  const abs = join(scan.root, sym.file);
  const lines = readLines(abs);
  const minGap = SEPARATED_KINDS.has(sym.kind) ? 1 : 0;
  const newLines = body.replace(/^\n+|\n+$/g, "").split("\n");
  const block: string[] = [];
  if (blankBefore && minGap && lines[index - 1]?.trim() !== "") block.push("");
  block.push(...newLines);
  if (blankAfter && minGap && lines[index]?.trim() !== "") block.push("");
  lines.splice(index, 0, ...block);
  atomicWriteText(abs, lines.join("\n"));
  return { file: sym.file, startLine: index + 1, endLine: index + block.length, lines: block.length };
}

// Insert `body` on the line after the symbol's declaration ends, keeping at
// least one blank line of separation for definition-like kinds.
export function insertAfterSymbol(scan: RepoScan, namePath: string, body: string, file?: string): EditResult {
  const sym = resolveUniqueSymbol(scan, namePath, file);
  const end = sym.endLine ?? sym.line;
  return insertAt(scan, sym, body, end, true, true);
}

// Insert `body` on the line where the symbol's declaration starts, pushing the
// symbol down, with the same separation rule.
export function insertBeforeSymbol(scan: RepoScan, namePath: string, body: string, file?: string): EditResult {
  const sym = resolveUniqueSymbol(scan, namePath, file);
  return insertAt(scan, sym, body, sym.line - 1, true, true);
}
