import type { CodeSymbol } from "../types.js";
import { annotate, extToLang, extractReexports, type Lexis } from "./common.js";
import { jsTs } from "./js-ts.js";
import { python } from "./python.js";
import { go } from "./go.js";
import { ruby } from "./ruby.js";
import { java } from "./java.js";
import { rust } from "./rust.js";
import { csharp } from "./csharp.js";
import { php } from "./php.js";
import { swift } from "./swift.js";
import { kotlin } from "./kotlin.js";
import { c } from "./c.js";
import { lua } from "./lua.js";
import { shell } from "./shell.js";
import { elixir } from "./elixir.js";
import { scala } from "./scala.js";
import { dart } from "./dart.js";
import { prisma } from "./prisma.js";

export interface Extractor {
  lang: string;
  exts: string[];
  // How to mask the language and read its doc comments (see lang/common.ts).
  // The registry masks once and hands the result to `extract`, whose rules
  // then match code only, and to `annotate`, which adds docs and body spans.
  lexis?: Lexis;
  extract(rel: string, content: string, masked?: string): CodeSymbol[];
  // The language's own reference sites, read in place of the generic regex
  // call scanner (extract/code.ts) when no grammar parsed the file. For a
  // language that has no calls at all but names its declarations elsewhere in
  // the same text (a Prisma field typed by a model), these are what the
  // caller index binds: `refs <name>` then lists every place that names it.
  calls?(content: string): { name: string; line: number }[];
}

// Registry of symbol extractors keyed by file extension. Adding a language is a
// matter of writing one `lang/<x>.ts` and registering it here — the same
// registry pattern reconstruct uses for its framework adapters.
const EXTRACTORS: Extractor[] = [
  jsTs, python, go, ruby, java, rust,
  csharp, php, swift, kotlin, c, lua, shell, elixir, scala, dart, prisma,
];

const BY_EXT = new Map<string, Extractor>();
for (const e of EXTRACTORS) for (const ext of e.exts) BY_EXT.set(ext, e);

// Extract declared symbols from one file. Returns [] for languages without a
// dedicated extractor (their content is still fully searchable via ripgrep).
//
// Also mirrors extractCode's barrel re-export/alias pass (extractReexports):
// a direct extractSymbols consumer (ultradoc, or any tool that doesn't go
// through extractCode) hits the same `export { a, b as c }` barrels a repo
// scan does, and should see the same alias-mirrors-b's-own-kind symbols —
// not the bare "reexport" kind extractReexports falls back to when there's
// no local declaration to mirror. extractCode already runs extractReexports
// itself and filters by name, so this can't double-add: whichever entry point
// adds "c" first wins, the other's re-run is a no-op duplicate filtered out.
//
// `onFailure` hears of an extractor that threw: its file then has no symbols,
// and the caller records that it failed (FileRecord.extractFailed) instead of
// presenting the file as one that declares nothing.
export function extractSymbols(rel: string, ext: string, content: string, onFailure?: () => void): CodeSymbol[] {
  const extractor = BY_EXT.get(ext);
  let symbols: CodeSymbol[];
  if (!extractor) symbols = [];
  else {
    try {
      const lexis = extractor.lexis;
      const masked = lexis?.mask?.(content);
      symbols = extractor.extract(rel, content, masked);
      if (lexis) symbols = annotate(symbols, content, lexis, masked);
    } catch {
      symbols = [];
      onFailure?.();
    }
  }
  const known = new Set(symbols.map((s) => s.name));
  const reexports = extractReexports(rel, content, symbols).filter((s) => !known.has(s.name));
  return reexports.length ? [...symbols, ...reexports] : symbols;
}

// The reference sites the extractor for `ext` reads itself (Extractor.calls),
// or undefined when it has none and the generic call scanner applies. An
// extractor that throws yields no sites, as extractSymbols yields no symbols.
export function extractorCalls(ext: string, content: string): { name: string; line: number }[] | undefined {
  const calls = BY_EXT.get(ext)?.calls;
  if (!calls) return undefined;
  try {
    return calls(content);
  } catch {
    return [];
  }
}

// Human-readable language label for an extension (used for the language
// histogram), falling back to the broad table for non-extracted languages.
export function languageOf(ext: string): string {
  return BY_EXT.get(ext)?.lang ?? extToLang(ext);
}

export { extToLang };
