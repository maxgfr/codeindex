// Query-only projections. Persisted records and cached answers retain their
// complete shape; opting into concise changes payload, never membership.
import type { CodeSymbol, SymbolIndex } from "../types.js";
import type { CallerEntry } from "../callers.js";
import type { SymbolReferences } from "../query.js";

export type SymbolLocation = Pick<CodeSymbol, "name" | "kind" | "file" | "line">;

export function symbolLocation(symbol: Pick<CodeSymbol, "kind" | "file" | "line">, name: string): SymbolLocation {
  return { name, kind: symbol.kind, file: symbol.file, line: symbol.line };
}

export function conciseCaller<T extends CallerEntry>(entry: T): Omit<T, "def"> & { def: SymbolLocation } {
  return { ...entry, def: symbolLocation(entry.def, entry.def.name) };
}

export function conciseReferences<T extends SymbolReferences>(refs: T): Omit<T, "defs"> & { defs: SymbolLocation[] } {
  return { ...refs, defs: refs.defs.map((s) => symbolLocation(s, s.name)) };
}

export function conciseSymbolIndex(index: SymbolIndex) {
  return {
    ...index,
    defs: Object.fromEntries(Object.entries(index.defs).map(([name, defs]) => [name, defs.map((s) => symbolLocation(s, name))])),
  };
}
