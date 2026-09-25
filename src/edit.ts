// Symbolic editing over AST line spans (Serena-parity, static edition):
// replace a symbol's body, insert after/before a symbol — the range math and
// blank-line normalization mirror the market leader's contract, but resolved
// from the deterministic index instead of a live language server. Line-span
// granularity: the caller supplies the replacement body verbatim, including
// its indentation (same contract as Serena's replace_symbol_body).
//
// Nothing is written until the edit has been checked: the target must still be
// where the index says, its span must be known exactly, and the edited text is
// re-extracted so a change to the file's structure OUTSIDE the edited lines is
// reported (or, with `strict`, refused) instead of silently accepted.
import { chmodSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, posix, relative } from "node:path";
import type { CodeSymbol } from "./types.js";
import type { RepoScan } from "./scan.js";
import { findSymbol } from "./query.js";
import { fileByRelFor } from "./derived.js";
import { extractCode } from "./extract/code.js";
import { grammarKeyForExt, grammarReady, parserFor } from "./ast/loader.js";
import { readTextEx, type Encoding } from "./text.js";
import { sha1 } from "./hash.js";
import { braceBodyEnd, leadingBlockStart } from "./edit-spans.js";
import { byStr } from "./sort.js";

// Symbol kinds that conventionally sit separated from neighbours by a blank
// line — insertions next to them keep at least one.
const SEPARATED_KINDS = new Set(["function", "method", "class", "interface", "struct", "trait", "enum", "def"]);

// The kinds find_symbol never returns: they locate an export statement, not a
// declaration, so they take no part in resolution or in the outline check.
const REFERENCE_KINDS = new Set(["reexport", "reexport-all", "default"]);

// Candidates named in an error message; the count is always given in full.
const MAX_LISTED = 20;

export interface EditResult {
  file: string;
  startLine: number; // 1-based, inclusive — the lines the edit touched
  endLine: number;
  lines: number; // lines written
  // What the post-edit check found (see verifyEdit). Absent when it found
  // nothing, so a clean edit's result keeps its historical shape.
  warnings?: string[];
}

export interface EditOptions {
  // Select one of several same-named declarations — a property's getter and
  // setter, TypeScript overloads — by its first line or any line in its span.
  line?: number;
  // Refuse the edit (throw, nothing written) when the post-edit check warns.
  strict?: boolean;
}

// Resolve a name path to exactly ONE symbol or throw with the candidate list
// (the agent then disambiguates — same contract as Serena's find_unique).
//
// Resolution runs over EVERY match. find_symbol's default cap of 50 is a
// response-size limit; applying it before the `file` filter made a definition
// that sorts past the 50th same-named match unreachable.
export function resolveUniqueSymbol(scan: RepoScan, namePath: string, file?: string, line?: number): CodeSymbol {
  let matches: CodeSymbol[] = findSymbol(scan, namePath, { maxResults: Infinity });
  const rel = file === undefined ? undefined : repoRelative(scan.root, file);
  if (file !== undefined) matches = matches.filter((m) => m.file === file || m.file === rel);
  const where = rel !== undefined ? ` in ${rel}` : "";
  if (matches.length === 0) {
    const near = findSymbol(scan, namePath, { substring: true, maxResults: 5 })
      .map((m) => `${m.file}:${m.line} ${m.parent ? m.parent + "/" : ""}${m.name}`)
      .join(", ");
    throw new Error(`no symbol matches "${namePath}"${where}${near ? ` — near matches: ${near}` : ""}`);
  }
  if (line !== undefined) {
    const candidates = matches;
    matches = candidates.filter((m) => m.line === line);
    if (!matches.length) {
      // Any line inside the span selects it; nested homonyms go to the innermost.
      const size = (m: CodeSymbol): number => (m.endLine ?? m.line) - m.line;
      const containing = candidates.filter((m) => m.line <= line && line <= (m.endLine ?? m.line));
      const least = Math.min(...containing.map(size));
      matches = containing.filter((m) => size(m) === least);
    }
    if (!matches.length) {
      throw new Error(`no "${namePath}"${where} is declared at or spans line ${line} — candidates: ${listed(candidates)}`);
    }
  }
  if (matches.length === 1) return matches[0]!;
  const files = new Set(matches.map((m) => m.file));
  if (files.size === 1) {
    // Neither `file` nor a Parent/name path can split same-file, same-parent
    // declarations; say what can.
    const lines = matches.map((m) => m.line).join(", ");
    throw new Error(`"${namePath}" is ambiguous (${matches.length} declarations in ${matches[0]!.file}, lines ${lines}) — pass \`line\`: one of ${lines}`);
  }
  throw new Error(
    `"${namePath}" is ambiguous (${matches.length} matches: ${listed(matches)}) — qualify with \`file\` or a Parent/name path, and \`line\` for same-file homonyms`,
  );
}

function listed(matches: readonly CodeSymbol[]): string {
  const shown = matches.slice(0, MAX_LISTED).map((m) => `${m.file}:${m.line}`).join(", ");
  return matches.length > MAX_LISTED ? `${shown}, … ${matches.length - MAX_LISTED} more` : shown;
}

// The spellings an agent naturally sends for `file` — `./src/a.ts`, Windows
// separators, an absolute path inside the repo — normalized to the index's rel.
function repoRelative(root: string, file: string): string {
  const rel = isAbsolute(file) ? relative(root, file) : file;
  return posix.normalize(rel.replace(/\\/g, "/"));
}

// --- the document --------------------------------------------------------------

// The file as lines plus each line's OWN terminator, so a mixed-EOL file keeps
// every untouched line byte-identical. `eols[i]` ends `lines[i]`; the final
// entry is "" (nothing follows the last line).
interface SourceDocument {
  lines: string[];
  eols: string[];
  newline: string; // the file's first terminator, for new lines with no neighbour to copy
  text(): string;
  encode(): Buffer;
}

// Decoding is the scanner's own (src/text.ts): the same BOM, UTF-16 and Latin-1
// decisions yield the same text, hence the line numbers the index recorded.
// Encoding writes that decision back unchanged.
function readDocument(abs: string): SourceDocument {
  const read = readTextEx(abs);
  if (!read.ok) throw new Error(`cannot read ${abs}`);
  if (read.binary || read.encoding === null) throw new Error(`cannot edit a binary file: ${abs}`);
  const encoding: Encoding = read.encoding;
  if ((encoding === "utf16le" || encoding === "utf16be") && (read.bytes - 2) % 2) {
    throw new Error("cannot edit malformed UTF-16 source: odd byte length");
  }
  const parts = read.text.split(/(\r?\n)/);
  const lines: string[] = [];
  const eols: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i]!);
    eols.push(parts[i + 1] ?? "");
  }
  const bom = Buffer.from(read.buf.subarray(0, read.bodyStart));
  return {
    lines,
    eols,
    newline: eols[0] || "\n",
    text() {
      let out = "";
      for (let i = 0; i < this.lines.length; i++) out += this.lines[i]! + this.eols[i]!;
      return out;
    },
    encode() {
      const text = this.text();
      if (encoding === "latin1") {
        if (/[^\x00-\xff]/.test(text)) throw new Error("replacement contains characters outside the source's Latin-1 encoding");
        return Buffer.from(text, "latin1");
      }
      if (encoding === "utf8" || encoding === "utf8-bom") return Buffer.concat([bom, Buffer.from(text, "utf8")]);
      const payload = Buffer.from(text, "utf16le");
      if (encoding === "utf16be") payload.swap16();
      return Buffer.concat([bom, payload]);
    },
  };
}

// Replace `count` lines at `index` with `inserted`. New lines copy the
// terminator of the line they replace or sit beside; the last one inherits
// what ended the replaced region, so a missing final newline stays missing.
function spliceLines(doc: SourceDocument, index: number, count: number, inserted: string[]): void {
  const { lines, eols } = doc;
  const style = (count ? [eols[index], eols[index - 1]] : [eols[index - 1], eols[index]]).find((e) => e) ?? doc.newline;
  const tail = count ? eols[index + count - 1]! : index < lines.length ? style : "";
  // Appending after a last line that had no terminator gives it one.
  if (!count && index === lines.length && index > 0) eols[index - 1] = style;
  lines.splice(index, count, ...inserted);
  eols.splice(index, count, ...inserted.map((_, i) => (i === inserted.length - 1 ? tail : style)));
}

function bodyLines(body: string): string[] {
  return body.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "").split("\n");
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
  atomicWrite(abs, content, cleanup);
}

function atomicWrite(abs: string, content: string | Buffer, cleanup: typeof rmSync = rmSync): void {
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

// --- the file's structure, before and after ----------------------------------

interface Outline {
  symbols: CodeSymbol[];
  truncated: boolean; // the per-file symbol cap cut the list: not comparable
}

const astTier = (ext: string): boolean => {
  const key = grammarKeyForExt(ext);
  return key !== undefined && grammarReady(key);
};

// The declarations in `text`, from the extractor the scan uses. The index's own
// record is reused when it provably describes this text as the current tier
// would (same content hash; endLine present exactly when the AST tier is
// loaded) — extracting a 30k-line file costs about a second.
function outlineOf(rel: string, ext: string, text: string, record?: RepoScan["files"][number]): Outline {
  if (record && record.hash === sha1(text) && record.symbols.some((s) => s.endLine !== undefined) === astTier(ext)) {
    return { symbols: record.symbols, truncated: record.truncated === true };
  }
  const info = extractCode(rel, ext, text);
  return { symbols: info.symbols, truncated: info.truncated === true };
}

// The scan says where the symbol WAS; the edit acts on the file as it IS. The
// server proves its scan fresh before every call, but a library caller may hold
// one from before an earlier edit, and splicing its line numbers into moved
// text corrupts the file. So the target must still be declared on its line —
// and the current extraction then supplies its exact span.
function relocate(sym: CodeSymbol, outline: Outline): CodeSymbol {
  const here = outline.symbols.filter((s) => s.name === sym.name && s.line === sym.line && !REFERENCE_KINDS.has(s.kind));
  const found = here.find((s) => s.kind === sym.kind && s.parent === sym.parent) ?? here[0];
  if (!found) {
    throw new Error(`"${sym.name}" is no longer declared at ${sym.file}:${sym.line} — the file changed after it was indexed; re-scan and retry`);
  }
  return found;
}

// The 1-based last line of the declaration. The AST tier records it; the regex
// tier records only the first line, and a guessed end is exactly how an edit
// leaves the old body dangling below the new one — so without an AST span only
// an unambiguous brace match (Swift, Kotlin, Dart) is accepted.
function declarationEnd(sym: CodeSymbol, lines: readonly string[], ext: string): number {
  if (sym.endLine !== undefined) return sym.endLine;
  const end = braceBodyEnd(lines, sym.line - 1, sym.lang);
  if (end !== undefined) return end + 1;
  const pull = grammarKeyForExt(ext) !== undefined ? "; `codeindex grammars pull` installs its AST grammar" : "";
  throw new Error(
    `cannot tell where "${sym.name}" ends in ${sym.file}: ${sym.lang} symbols come from the regex tier, which records only the first line${pull}. ` +
      "Inserting before the symbol still works; otherwise edit the file directly",
  );
}

const qualified = (s: CodeSymbol): string => {
  const parent = s.parentPath ?? s.parent;
  return parent ? `${parent}/${s.name}` : s.name;
};

// Structural and syntactic checks of an edit that has NOT been written yet.
// Lines index+1..index+count were replaced by index+1..index+len; everything
// else must describe the same declarations, shifted by the length change.
function verifyEdit(
  rel: string,
  ext: string,
  before: Outline,
  oldText: string,
  newText: string,
  edit: { index: number; count: number; len: number; target?: CodeSymbol },
): string[] {
  const warnings: string[] = [];
  const { index, count, len, target } = edit;
  const a = index + 1; // first edited line, both sides
  const oldEnd = index + count; // last replaced line (index itself when inserting)
  const newEnd = index + len;
  const delta = len - count;
  const after = outlineOf(rel, ext, newText);

  if (!before.truncated && !after.truncated) {
    // Each declaration outside the edit is keyed by kind, qualified name and
    // (shifted) span. An end line inside the edited region is left out: it is
    // the edit's to change. So is, for an insertion, an end on the line right
    // above it — that declaration may legitimately absorb the new lines (an
    // indented method appended to a Python class) or not.
    const loose = count ? a : index;
    const endKey = (end: number | undefined, last: number, shift: number): string =>
      end === undefined || (end >= loose && end <= last) ? "" : `-${end > last ? end + shift : end}`;
    // A multiset: key → (count, label). Labels give the span as the reader
    // knows it — before the edit for a lost declaration, after it for a gained one.
    type Tally = Map<string, { n: number; label: string }>;
    const tally = (symbols: CodeSymbol[], last: number, shift: number): Tally => {
      const out: Tally = new Map();
      for (const s of symbols) {
        if (REFERENCE_KINDS.has(s.kind) || (s.line >= a && s.line <= last)) continue;
        const end = endKey(s.endLine, last, shift);
        const key = `${s.kind} ${qualified(s)} ${s.line > last ? s.line + shift : s.line}${end}`;
        const seen = out.get(key);
        if (seen) seen.n++;
        else out.set(key, { n: 1, label: `${qualified(s)} (${s.kind}, ${end ? `lines ${s.line}-${s.endLine}` : `line ${s.line}`})` });
      }
      return out;
    };
    const expected = tally(before.symbols, oldEnd, delta);
    const actual = tally(after.symbols, newEnd, 0);
    const missingFrom = (from: Tally, other: Tally): string[] =>
      [...from.keys()].filter((k) => from.get(k)!.n > (other.get(k)?.n ?? 0)).sort(byStr);
    const lost = missingFrom(expected, actual);
    const gained = missingFrom(actual, expected);
    if (lost.length || gained.length) {
      const show = (keys: string[], from: Tally): string =>
        keys.slice(0, 5).map((k) => from.get(k)!.label).join(", ") + (keys.length > 5 ? `, … ${keys.length - 5} more` : "");
      const parts = [lost.length ? `lost ${show(lost, expected)}` : "", gained.length ? `gained ${show(gained, actual)}` : ""];
      warnings.push(`the edit changed declarations outside lines ${a}-${newEnd}: ${parts.filter(Boolean).join("; ")}`);
    }
    if (target && !after.symbols.some((s) => s.line >= a && s.line <= newEnd && s.name === target.name && qualified(s) === qualified(target))) {
      warnings.push(`"${qualified(target)}" is no longer declared in lines ${a}-${newEnd}`);
    }
  }

  const errors = syntaxErrorLines(ext, newText);
  if (errors?.length) {
    // Compare against the file's own pre-existing errors, mapped through the edit.
    const known = new Set((syntaxErrorLines(ext, oldText) ?? []).map((l) => (l > oldEnd ? l + delta : l)));
    const fresh = errors.filter((l) => !known.has(l));
    if (fresh.length) warnings.push(`the edited file has ${fresh.length} new syntax error(s), first at line ${fresh[0]}`);
  }
  return warnings;
}

// The tree-sitter node surface this check reads (typed structurally, like src/ast/node.ts).
interface ErrorNode {
  hasError: boolean;
  isError: boolean;
  isMissing: boolean;
  startPosition: { row: number };
  children: ErrorNode[];
}

// Start lines of the ERROR and MISSING nodes tree-sitter recovers with, or
// undefined without a loaded grammar. Only subtrees flagged hasError are
// walked, so a clean file costs one parse.
function syntaxErrorLines(ext: string, text: string): number[] | undefined {
  const key = grammarKeyForExt(ext);
  if (!key || !grammarReady(key)) return undefined;
  const parser = parserFor(key);
  const tree = parser?.parse(text) as { rootNode: ErrorNode; delete(): void } | null | undefined;
  if (!tree) return undefined;
  try {
    const lines: number[] = [];
    const stack = tree.rootNode.hasError ? [tree.rootNode] : [];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.isError || node.isMissing) lines.push(node.startPosition.row + 1);
      for (const child of node.children) if (child.hasError) stack.push(child);
    }
    return lines.sort((x, y) => x - y);
  } finally {
    tree.delete();
  }
}

// --- the three edits -----------------------------------------------------------

type Operation = "replace" | "after" | "before";

function applyEdit(scan: RepoScan, namePath: string, body: string, op: Operation, file?: string, opts: EditOptions = {}): EditResult {
  const sym = resolveUniqueSymbol(scan, namePath, file, opts.line);
  const abs = join(scan.root, sym.file);
  const doc = readDocument(abs);
  const oldText = doc.text();
  const record = fileByRelFor(scan).get(sym.file);
  const ext = record?.ext ?? extname(sym.file);
  const before = outlineOf(sym.file, ext, oldText, record);
  const target = relocate(sym, before);
  const newLines = bodyLines(body);

  let index: number;
  let count = 0;
  let inserted = newLines;
  if (op === "replace") {
    index = target.line - 1;
    count = declarationEnd(target, doc.lines, ext) - index;
  } else {
    // After the declaration's last line, or above its decorators and doc
    // comment: between those and the declaration, new code would inherit the
    // decorator and detach the comment from its owner.
    index = op === "after" ? declarationEnd(target, doc.lines, ext) : leadingBlockStart(doc.lines, target.line - 1, target.lang);
    const gap = SEPARATED_KINDS.has(target.kind);
    inserted = [
      ...(gap && index > 0 && doc.lines[index - 1]!.trim() !== "" ? [""] : []),
      ...newLines,
      ...(gap && index < doc.lines.length && doc.lines[index]!.trim() !== "" ? [""] : []),
    ];
  }
  spliceLines(doc, index, count, inserted);

  const warnings = verifyEdit(sym.file, ext, before, oldText, doc.text(), {
    index,
    count,
    len: inserted.length,
    target: op === "replace" ? target : undefined,
  });
  if (warnings.length && opts.strict) throw new Error(`edit refused (strict), nothing written: ${warnings.join("; ")}`);
  atomicWrite(abs, doc.encode());
  const result: EditResult =
    op === "replace"
      ? { file: sym.file, startLine: target.line, endLine: target.line + newLines.length - 1, lines: newLines.length }
      : { file: sym.file, startLine: index + 1, endLine: index + inserted.length, lines: inserted.length };
  if (warnings.length) result.warnings = warnings;
  return result;
}

// Replace the symbol's whole declaration (lines start..endLine) with `body`.
// The body is taken verbatim after trimming outer blank lines — supply it
// fully indented for its context. The span is the declaration's own: a doc
// comment above it, and decorators the grammar keeps outside the node
// (TypeScript, Python, Rust), are left in place.
export function replaceSymbolBody(scan: RepoScan, namePath: string, body: string, file?: string, opts?: EditOptions): EditResult {
  return applyEdit(scan, namePath, body, "replace", file, opts);
}

// Insert `body` on the line after the symbol's declaration ends, keeping at
// least one blank line of separation for definition-like kinds.
export function insertAfterSymbol(scan: RepoScan, namePath: string, body: string, file?: string, opts?: EditOptions): EditResult {
  return applyEdit(scan, namePath, body, "after", file, opts);
}

// Insert `body` above the symbol — above its decorators and the doc comment
// directly attached to it — pushing the symbol down, with the same separation
// rule.
export function insertBeforeSymbol(scan: RepoScan, namePath: string, body: string, file?: string, opts?: EditOptions): EditResult {
  return applyEdit(scan, namePath, body, "before", file, opts);
}
