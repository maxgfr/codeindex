// One way to name a symbol, shared by every navigation query.
//
// Each command used to grow its own syntax. `callers` took `name@file`, but
// only because its index happens to key the 2nd+ homonym that way; `hierarchy`
// and `implementations` took only the key their map stored, so the FIRST
// homonym's `name@file` said "no type named"; `callgraph` wanted a symbol id
// (`file#Parent/name`) and rejected `name@file`; find_references read the
// bare key only. An id copied out of one answer could not be pasted into the
// next. Every one of them now reads the same forms:
//
//   name               the name as declared (a single-answer command keeps
//                      its historical pick among homonyms: the first)
//   name@file          the declaration of `name` in `file`
//   file#name          a symbol id, as callgraph prints it
//   file#Parent/name   a member's symbol id
//   Parent/name        a member of `Parent` (a longer `A/B/name` path works too)
//
// A ref is read LITERALLY first, so a name that really contains "@", "#" or
// "/" (Ruby's unary `-@`, an operator method) still finds itself. The other
// readings are tried in turn and the first that matches anything wins: a file
// path may contain "@" or "#" itself (`src/@types/x.ts#Foo`), and trying each
// split is simpler and more robust than guessing which one is meant.
//
// Pure string work only — callers own the lookup, because each structure
// (caller index, hierarchy, symbol graph, the scan) stores symbols its own way.

/** One reading of a symbol ref. Absent fields match anything. */
export interface SymbolRef {
  name: string;
  file?: string;
  /** Enclosing symbol path, `Parent` or `Outer/Parent`. */
  parent?: string;
}

/** Every reading of `ref`, most literal first. Never empty. */
export function symbolRefReadings(ref: string): SymbolRef[] {
  const out: SymbolRef[] = [{ name: ref }];
  // A symbol id: `file#name` or `file#Parent/name`. Split at the LAST "#" —
  // a path may contain one, a name never does.
  const hash = ref.lastIndexOf("#");
  if (hash > 0 && hash < ref.length - 1) out.push(memberPath(ref.slice(hash + 1), ref.slice(0, hash)));
  // `name@file`: any "@" may be the separator (a path can hold one too).
  for (let at = ref.indexOf("@"); at !== -1; at = ref.indexOf("@", at + 1)) {
    if (at > 0 && at < ref.length - 1) out.push({ name: ref.slice(0, at), file: ref.slice(at + 1) });
  }
  // `Parent/name`. Not read into a ref carrying "@" or "#": there the slashes
  // belong to the file path.
  if (hash < 0 && !ref.includes("@")) {
    const member = memberPath(ref);
    if (member.parent !== undefined) out.push(member);
  }
  return out;
}

function memberPath(path: string, file?: string): SymbolRef {
  const slash = path.lastIndexOf("/");
  const ref: SymbolRef =
    slash > 0 && slash < path.length - 1 ? { name: path.slice(slash + 1), parent: path.slice(0, slash) } : { name: path };
  if (file !== undefined) ref.file = file;
  return ref;
}

/**
 * Whether a declaration answers to one reading. A parent path matches the
 * symbol's ancestor path or a trailing, segment-aligned part of it, so both
 * `Outer/Inner/m` and `Inner/m` find `m` inside `Outer/Inner`.
 */
export function refMatches(
  r: SymbolRef,
  s: { name: string; file: string; parent?: string; parentPath?: string },
): boolean {
  if (s.name !== r.name) return false;
  if (r.file !== undefined && s.file !== r.file) return false;
  if (r.parent === undefined) return true;
  const path = s.parentPath ?? s.parent;
  return path !== undefined && (path === r.parent || path.endsWith(`/${r.parent}`));
}

/** The canonical `Parent/name@file` spelling of a reading (what the LSP tier parses). */
export function formatSymbolRef(r: SymbolRef): string {
  return `${r.parent !== undefined ? `${r.parent}/` : ""}${r.name}${r.file !== undefined ? `@${r.file}` : ""}`;
}
