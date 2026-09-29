// Query-only projections. Persisted records and cached answers retain their
// complete shape; opting into concise changes payload, never membership.
import type { CodeSymbol, SymbolIndex } from "../types.js";
import type { CallerEntry } from "../callers.js";
import type { SymbolReferences } from "../query.js";
import type { DeltaChange, DeltaResult } from "../delta.js";

// `parent` rides along when there is one: it is what makes a member
// addressable. Without it `ResponseWriter/Flush` and `responseWriter/Flush`
// both read as `Flush`, and the Parent/name path the edit tools and
// find_symbol take could not be formed without a second, full call.
export type SymbolLocation = Pick<CodeSymbol, "name" | "kind" | "file" | "line" | "parent">;

export function symbolLocation(symbol: Pick<CodeSymbol, "kind" | "file" | "line" | "parent">, name: string): SymbolLocation {
  return { name, kind: symbol.kind, file: symbol.file, line: symbol.line, ...(symbol.parent ? { parent: symbol.parent } : {}) };
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

// A review's changes without their hunks and line counts, each enclosing symbol
// reduced to where it is. Modules, reasons and broken imports are untouched.
export function conciseDelta<T extends DeltaResult>(res: T) {
  return {
    ...res,
    changes: res.changes.map((c: DeltaChange) => ({
      path: c.path,
      status: c.status,
      ...(c.oldPath !== undefined ? { oldPath: c.oldPath } : {}),
      ...(c.module !== undefined ? { module: c.module } : {}),
      symbols: c.symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line })),
    })),
  };
}
