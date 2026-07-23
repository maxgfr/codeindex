import type { CodeSymbol } from "../types.js";
import { extToLang, extractReexports } from "./common.js";
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

export interface Extractor {
  lang: string;
  exts: string[];
  extract(rel: string, content: string): CodeSymbol[];
}

// Registry of symbol extractors keyed by file extension. Adding a language is a
// matter of writing one `lang/<x>.ts` and registering it here — the same
// registry pattern reconstruct uses for its framework adapters.
const EXTRACTORS: Extractor[] = [
  jsTs, python, go, ruby, java, rust,
  csharp, php, swift, kotlin, c, lua, shell, elixir, scala,
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
export function extractSymbols(rel: string, ext: string, content: string): CodeSymbol[] {
  const extractor = BY_EXT.get(ext);
  let symbols: CodeSymbol[];
  if (!extractor) symbols = [];
  else {
    try {
      symbols = extractor.extract(rel, content);
    } catch {
      symbols = [];
    }
  }
  const known = new Set(symbols.map((s) => s.name));
  const reexports = extractReexports(rel, content, symbols).filter((s) => !known.has(s.name));
  return reexports.length ? [...symbols, ...reexports] : symbols;
}

// Human-readable language label for an extension (used for the language
// histogram), falling back to the broad table for non-extracted languages.
export function languageOf(ext: string): string {
  return BY_EXT.get(ext)?.lang ?? extToLang(ext);
}

export { extToLang };
