// The call-site binder: which declaration ONE call site reaches.
//
// graph.json's `call` edges (resolveCallEdges), `callers` (buildCallerIndex),
// `callgraph` (buildSymbolGraph) and SCIP references all ask this one binder,
// so they cannot disagree about a call. It used to be three copies of a rule
// that looked at the callee NAME only, and a name alone binds `errors.New(…)`
// to gin's `New`, `kwargs.update(…)` to a flask example's `update` view and
// `this.map.get(k)` to the enclosing `Store.get`. A call site says more than
// its name, and every extra fact here is deterministic and type-free:
//
//   * its RECEIVER: none (`f()`), the enclosing object (`self.f()`, Go's
//     receiver variable), a module the file imports (`pkg.F()`, `ns.f()`), or
//     anything else (`x.f()`);
//   * what the file's imports RENAME (`import { a as b }`, a default import,
//     `from m import a as b`) and what a barrel RE-EXPORTS;
//   * the language's own visibility rules: a Go package is its directory, a
//     Go `_test.go` file is invisible to the package's other files, a Python
//     name comes from the module's own scope or an import.
//
// Two modes. The default answers for precision: a site binds only where the
// language says it can. Recall mode (callers --recall, issue #7) keeps the
// earlier name-driven rules — local shadowing whatever the receiver, proximity
// inference everywhere, JS/TS's unique-name relaxation — on top of the new
// evidence, and labels what it found by name alone.
import type { CodeSymbol, FileRecord } from "./types.js";
import type { RepoScan } from "./scan.js";
import { resolveImport, type ResolveContext } from "./resolve.js";
import { addDef, defsOutside, familyOf, importTargets, importedDefs, pickCandidate, type DefGroup, type DefTable } from "./calls.js";
import { enclosingAmong } from "./callers.js";
import { resolveContextFor } from "./derived.js";
import { tierForPath } from "./modules.js";
import { isTestCaseFile, isTestPath } from "./tests-map.js";
import { byStr } from "./sort.js";

const REFERENCE_KINDS = new Set(["reexport", "reexport-all", "default"]);

// Families whose names reach another file ONLY through what the file states:
// an import (JS/TS) or package membership (Go). A same-name match without that
// evidence is something the language itself rules out, so the default mode
// never infers there. Every other family keeps the unique-name / proximity
// inference: Ruby and PHP autoload, C links globally, a Swift module needs no
// imports — and a Python module gains names at run time (star imports,
// assignments) while `x.f()` names no class at all, so Python keeps it too,
// minus test and tail files (see isTail).
const STRICT = new Set(["js", "go"]);

// Families where a call's SHAPE says what it can reach. A bare `f()` is never
// a method (a method needs `self.f()` / `c.F()`), and `x.f()` on a variable is
// never a free function (a module-level function is reached through its
// module). JS/TS is left out on purpose: `this.f()` reaches the extractor with
// no receiver at all, so a bare-looking call may well be a method.
const SHAPED = new Set(["go", "python"]);

// Families whose unit of visibility is the DIRECTORY: a file sees every
// declaration of its package mates without importing them.
const PACKAGE_DIR = new Set(["go", "java"]);

// How far a declaration the language does NOT export still reaches. Go's
// lowercase names and Java's package-private members are visible to package
// mates (gin calls `debugPrint` from 14 files); Python's leading underscore is
// a convention, so an import reaches them (`self._find_error_handler` in a
// subclass file).
const PRIVATE_REACH: Record<string, "package" | "import"> = { go: "package", java: "package", python: "import" };

// Receivers that name the enclosing object. JS/TS/Java `this` and Rust `self`
// never get here (the extractor reads no receiver from them); PHP's `$this`
// does, as "this".
const SELF_NAMES = new Set(["self", "cls", "this", "Self"]);

const FUNCTION_KINDS = new Set(["function", "method", "def", "constructor", "operator"]);

// How many re-export hops a barrel chain may take (`index.ts` → `sub/index.ts`
// → the declaration). Deeper chains are rare, and each hop widens the set.
const MAX_HOPS = 3;

export interface CallSite {
  name: string;
  line: number;
  receiver?: string;
}

/** What one call site binds to. `corroborated`: stated evidence (the file itself, an import, a re-export chain, package membership) backs it; false for a name-only inference. */
export interface BoundCall {
  def: CodeSymbol;
  corroborated: boolean;
}

// What a file's imports make its names mean (resolved lazily, per file).
interface FileAliases {
  // receiver name → the files that module spans (a Go package: every non-test
  // file of its directory), or null when the module lives outside the repo.
  modules: Map<string, string[] | null>;
  // bare name → the declaration it renames, and the files it comes from (null
  // when that module is outside the repo).
  names: Map<string, { name: string; files: string[] | null }>;
}
const NO_ALIASES: FileAliases = { modules: new Map(), names: new Map() };

const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const isGoTest = (rel: string): boolean => rel.endsWith("_test.go");

// A Go import path's package name when the package is not in the repo: its
// last element, less a major-version suffix (`/v10`, `.v3`) and the `go-`
// affix convention (`go-isatty` → isatty). A guess at an external name is
// cheap to get wrong: the worst case leaves the call to the ordinary rules.
function goExternalName(spec: string): string {
  const segs = spec.split("/");
  let last = segs.pop() ?? spec;
  if ((/^v\d+$/.test(last) || last === "go") && segs.length) last = segs.pop()!;
  return last.replace(/\.v\d+$/, "").replace(/^go-/, "").replace(/[-.]go$/, "").replace(/\W/g, "");
}

// The type a header declares for `name`: a Go parameter (`c *Context`,
// `r *http.Request`) or a Python annotation (`app: "Flask"`). `type` is the
// last segment of a qualified type, `qualifier` its first (`http`) when it has
// one; undefined when the header does not say.
const declaredRe = new Map<string, RegExp>();
function declaredType(signature: string, name: string): { type: string; qualifier?: string } | undefined {
  if (!signature.includes(name)) return undefined; // the common case, without a regex
  let re = declaredRe.get(name);
  if (!re) {
    re = new RegExp(`(?:^|[(,\\s])${name}\\s*(?::\\s*["']?|\\s+[*&]?)\\s*(?:([A-Za-z_]\\w*)\\.)?(?:[A-Za-z_]\\w*\\.)*([A-Za-z_]\\w*)`);
    if (declaredRe.size < 4096) declaredRe.set(name, re);
  }
  const m = re.exec(signature);
  return m ? { type: m[2]!, qualifier: m[1] } : undefined;
}

// A Go method's receiver variable, read off its header (`func (c *Context) …`).
function goReceiverVar(s: CodeSymbol | undefined): string | undefined {
  if (!s?.signature || s.kind !== "method") return undefined;
  return /^func\s*\(\s*([A-Za-z_]\w*)\s/.exec(s.signature)?.[1];
}

/**
 * Per-scan binding facts shared by every binder: import targets, re-export
 * hops, package directories and resolved import aliases. relations.ts reads
 * the same facts to bind a base-class name.
 */
export interface BindScope {
  /** The files `rel` imports (resolved, self-pairs dropped). */
  targets(rel: string): ReadonlySet<string> | undefined;
  /** The defs of `group` that `f` reaches through a stated import, a re-export chain or its package — never `f` itself. */
  reached<T extends CodeSymbolLike>(group: DefGroup<T> | undefined, f: FileRecord, name: string): T[];
  /** The defs of `group` declared in `files`, or re-exported by them. */
  within<T extends CodeSymbolLike>(group: DefGroup<T> | undefined, files: readonly string[], name: string): T[];
  /** What `f`'s imports make its names mean. */
  aliases(f: FileRecord): FileAliases;
}

/** The fields the scope reads off a definition. */
export interface CodeSymbolLike {
  file: string;
  lang: string;
  name: string;
  parent?: string;
}

// Alias resolution depends on the scan and the resolve context only, so it is
// shared by every binder built over the same pair (a session builds several).
const aliasMemo = new WeakMap<RepoScan, { ctx: ResolveContext; files: Map<string, FileAliases> }>();

export function createBindScope(scan: RepoScan, pairs: Set<string>, ctxIn?: ResolveContext): BindScope {
  const targetsOf = importTargets(pairs);
  let byRel: Map<string, FileRecord> | undefined;
  const fileOf = (rel: string): FileRecord | undefined => (byRel ??= new Map(scan.files.map((f) => [f.rel, f]))).get(rel);

  // Barrels: files that re-export by name (`export { a } from`, Python's
  // `from .m import a as a`) or wholesale (`export * from`, and a Python
  // package `__init__.py`, whose every import is an attribute of the package).
  const barrels = new Map<string, { all: boolean; names: Set<string> }>();
  for (const f of scan.files) {
    let info = f.rel.endsWith("/__init__.py") || f.rel === "__init__.py" ? { all: true, names: new Set<string>() } : undefined;
    for (const s of f.symbols) {
      if (s.kind !== "reexport" && s.kind !== "reexport-all") continue;
      info ??= { all: false, names: new Set() };
      if (s.kind === "reexport-all") info.all = true;
      else info.names.add(s.name);
    }
    if (info) barrels.set(f.rel, info);
  }

  // The files a re-export chain from barrel `b` reaches for `name`: every
  // import of a barrel that re-exports the name (or everything), recursively.
  const hopMemo = new Map<string, Set<string>>();
  const hop = (b: string, name: string): ReadonlySet<string> => {
    const key = `${b}\u0000${name}`;
    let reached = hopMemo.get(key);
    if (reached) return reached;
    reached = new Set();
    let frontier = [b];
    for (let d = 0; d < MAX_HOPS && frontier.length; d++) {
      const next: string[] = [];
      for (const x of frontier) {
        const info = barrels.get(x);
        if (!info || !(info.all || info.names.has(name))) continue;
        for (const t of targetsOf.get(x) ?? []) {
          if (t === b || reached.has(t)) continue;
          reached.add(t);
          next.push(t);
        }
      }
      frontier = next;
    }
    hopMemo.set(key, reached);
    return reached;
  };

  // A package's files, per family and directory, sorted.
  let pkgFiles: Map<string, FileRecord[]> | undefined;
  const packageOf = (family: string, dir: string): FileRecord[] => {
    if (!pkgFiles) {
      pkgFiles = new Map();
      for (const f of scan.files) {
        const fam = familyOf(f.lang);
        if (!PACKAGE_DIR.has(fam) || f.kind !== "code") continue;
        const key = `${fam}\u0000${dirOf(f.rel)}`;
        let list = pkgFiles.get(key);
        if (!list) pkgFiles.set(key, (list = []));
        list.push(f);
      }
    }
    return pkgFiles.get(`${family}\u0000${dir}`) ?? [];
  };
  // What `f` sees as package mates: its own directory and, for Go, every
  // package it imports. Go compiles a `_test.go` file only with its own
  // package's tests, so only a test file sees one, and only its own. Kept as
  // DIRECTORIES, not files: typescript-go has 4,357 test files in one package,
  // and a set of all the others per file was 19M inserts.
  interface Mates {
    own: string;
    test: boolean;
    imported: ReadonlySet<string>; // other package dirs (Go only)
  }
  const mateMemo = new Map<string, Mates | null>();
  const matesOf = (f: FileRecord): Mates | null => {
    const family = familyOf(f.lang);
    if (!PACKAGE_DIR.has(family)) return null;
    let mates = mateMemo.get(f.rel);
    if (mates !== undefined) return mates;
    const own = dirOf(f.rel);
    const imported = new Set<string>();
    if (family === "go") {
      for (const t of targetsOf.get(f.rel) ?? []) if (t.endsWith(".go") && dirOf(t) !== own) imported.add(dirOf(t));
    }
    mateMemo.set(f.rel, (mates = { own, test: isGoTest(f.rel), imported }));
    return mates;
  };
  // Defs of `group` among `f`'s package mates. Walks the group when it is the
  // smaller side, else its per-directory index (built once per group).
  const byDirMemo = new WeakMap<object, Map<string, CodeSymbolLike[]>>();
  const defsInMates = <T extends CodeSymbolLike>(group: DefGroup<T>, f: FileRecord, m: Mates, out: T[], seen: Set<string>): void => {
    const take = (d: T, dir: string): void => {
      if (d.file === f.rel || seen.has(d.file)) return;
      if (dir === m.own ? m.test || !isGoTest(d.file) : m.imported.has(dir) && !isGoTest(d.file)) seen.add(d.file), out.push(d);
    };
    if (group.list.length <= m.imported.size + 1) {
      for (const d of group.list) take(d, dirOf(d.file));
      return;
    }
    let idx = byDirMemo.get(group) as Map<string, T[]> | undefined;
    if (!idx) {
      idx = new Map();
      for (const d of group.list) {
        const dir = dirOf(d.file);
        const list = idx.get(dir);
        if (list) list.push(d);
        else idx.set(dir, [d]);
      }
      byDirMemo.set(group, idx);
    }
    for (const d of idx.get(m.own) ?? []) take(d, m.own);
    for (const dir of m.imported) for (const d of idx.get(dir) ?? []) take(d, dir);
  };

  // Defs of `group` in `files`, walked from the smaller side.
  const defsIn = <T extends CodeSymbolLike>(group: DefGroup<T>, files: ReadonlySet<string>, out: T[], seen: Set<string>): void => {
    if (files.size < group.list.length) {
      for (const file of files) {
        const d = group.byFile.get(file);
        if (d && !seen.has(d.file)) seen.add(d.file), out.push(d);
      }
    } else {
      for (const d of group.list) if (files.has(d.file) && !seen.has(d.file)) seen.add(d.file), out.push(d);
    }
  };

  // Through a barrel: the name itself, or — for a member — its class, when
  // the barrel re-exports the class by name only.
  const viaBarrels = <T extends CodeSymbolLike>(group: DefGroup<T>, from: Iterable<string>, name: string, out: T[], seen: Set<string>): void => {
    for (const b of from) {
      const info = barrels.get(b);
      if (!info) continue;
      defsIn(group, hop(b, name), out, seen);
      if (info.all || !info.names.size) continue;
      for (const d of group.list) {
        if (d.parent && !seen.has(d.file) && info.names.has(d.parent) && hop(b, d.parent).has(d.file)) seen.add(d.file), out.push(d);
      }
    }
  };

  const reached = <T extends CodeSymbolLike>(group: DefGroup<T> | undefined, f: FileRecord, name: string): T[] => {
    if (!group) return [];
    const mates = matesOf(f);
    // A Go import pair points at ONE representative file of the package (its
    // first by name, a `_test.go` file as often as not); the package itself
    // is what the file sees, and the mates say exactly that.
    if (mates && f.lang === "go") {
      const out: T[] = [];
      defsInMates(group, f, mates, out, new Set());
      return out;
    }
    const targets = targetsOf.get(f.rel);
    const out = importedDefs(group, targets);
    const seen = new Set(out.map((d) => d.file));
    seen.add(f.rel);
    if (targets) viaBarrels(group, targets, name, out, seen);
    if (mates) defsInMates(group, f, mates, out, seen);
    return out;
  };

  const within = <T extends CodeSymbolLike>(group: DefGroup<T> | undefined, files: readonly string[], name: string): T[] => {
    if (!group) return [];
    const out: T[] = [];
    const seen = new Set<string>();
    defsIn(group, new Set(files), out, seen);
    viaBarrels(group, files, name, out, seen);
    return out;
  };

  // --- import aliases -------------------------------------------------------
  let ctx = ctxIn;
  let memo = aliasMemo.get(scan);
  const aliasFiles = (): Map<string, FileAliases> => {
    ctx ??= resolveContextFor(scan);
    if (memo?.ctx !== ctx) aliasMemo.set(scan, (memo = { ctx, files: new Map() }));
    return memo.files;
  };

  // The declaration a JS module's default export names: its own record of
  // `export default X`, the regex tier's `default` symbol, or the file-stem
  // symbol the declaration walk gives an anonymous default.
  const defaultOf = (rel: string): string | undefined => {
    const t = fileOf(rel);
    if (!t) return undefined;
    const own = t.importAliases?.find((a) => a.local === "default" && a.from === undefined);
    if (own) return own.name;
    const marked = t.symbols.find((s) => s.kind === "default");
    if (marked) return marked.name;
    const stem = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
    return t.symbols.some((s) => s.name === stem && !s.parent) ? stem : undefined;
  };

  // A Go package directory's declared name (its `package` clause).
  const goPackageName = (dir: string): string | undefined =>
    packageOf("go", dir).find((m) => !isGoTest(m.rel))?.symbols.find((s) => s.kind === "package")?.name;

  const aliases = (f: FileRecord): FileAliases => {
    const goFile = f.lang === "go";
    if (!f.importAliases?.length && !(goFile && f.refs.length)) return NO_ALIASES;
    const files = aliasFiles();
    let a = files.get(f.rel);
    if (a) return a;
    a = { modules: new Map(), names: new Map() };
    const resolved = (spec: string): string | null => {
      const r = resolveImport(f.rel, f.ext, spec, ctx!);
      return r.kind === "resolved" && r.target !== f.rel ? r.target : null;
    };
    const addModule = (local: string, targets: string[] | null): void => {
      const prev = a!.modules.get(local);
      if (prev === undefined || prev === null) a!.modules.set(local, targets);
      else if (targets) a!.modules.set(local, [...new Set([...prev, ...targets])].sort(byStr));
    };
    if (goFile) {
      // Every Go import binds a qualifier: its explicit alias, else the
      // package's declared name (the directory's, for an in-repo package).
      const explicit = new Map<string, string>();
      for (const al of f.importAliases ?? []) if (al.from !== undefined) explicit.set(al.from, al.local);
      for (const ref of f.refs) {
        if (ref.kind !== "import") continue;
        const t = resolved(ref.spec);
        const dir = t === null ? undefined : dirOf(t);
        const local = explicit.get(ref.spec) ?? (dir !== undefined ? goPackageName(dir) : undefined) ?? goExternalName(ref.spec);
        addModule(local, dir !== undefined ? packageOf("go", dir).filter((m) => !isGoTest(m.rel)).map((m) => m.rel) : null);
      }
    } else {
      for (const al of f.importAliases ?? []) {
        if (al.from === undefined) continue; // the module's own `export default X`
        const t = resolved(al.from);
        if (al.name === "*") {
          addModule(al.local, t ? [t] : null);
          continue;
        }
        if (f.lang === "python") {
          // `from pkg import mod as m` binds a SUBMODULE when pkg/mod.py exists.
          const sub = resolved(al.from.endsWith(".") ? al.from + al.name : `${al.from}.${al.name}`);
          if (sub && sub !== t) {
            addModule(al.local, [sub]);
            continue;
          }
        }
        if (a.names.has(al.local)) continue;
        const name = al.name === "default" ? (t ? defaultOf(t) : undefined) ?? al.local : al.name;
        a.names.set(al.local, { name, files: t ? [t] : null });
      }
    }
    files.set(f.rel, a);
    return a;
  };

  return { targets: (rel) => targetsOf.get(rel), reached, within, aliases };
}

// One name's definitions, three ways. `any` keeps the first per (name, file)
// whatever it is — the pool every binder always used, and still the one for a
// family whose call shape proves nothing. `free` and `member` keep the first
// of each kind, so a file declaring both a type `Error` and a method
// `Error.Error` offers the method to `err.Error()` and the type to `Error{}`.
interface Tables {
  any: DefTable<CodeSymbol>;
  free: DefTable<CodeSymbol>;
  member: DefTable<CodeSymbol>;
}
type Pool = "any" | "free" | "member" | "member-first";
const newTables = (): Tables => ({ any: new Map(), free: new Map(), member: new Map() });
function addTo(t: Tables, s: CodeSymbol, member: boolean): void {
  addDef(t.any, s.name, s);
  addDef(member ? t.member : t.free, s.name, s);
}
// The group a call of the given pool draws from. `member-first` merges the
// two kinds, a file's member winning over its free homonym: Python's `x.f()`
// is a method call unless `x` is a module, which only an import can say.
function groupOf(t: Tables, name: string, family: string, pool: Pool): DefGroup<CodeSymbol> | undefined {
  if (pool !== "member-first") return t[pool].get(name)?.get(family);
  const member = t.member.get(name)?.get(family);
  const free = t.free.get(name)?.get(family);
  if (!member || !free) return member ?? free;
  const byFile = new Map(member.byFile);
  const list = [...member.list];
  for (const d of free.list) if (!byFile.has(d.file)) byFile.set(d.file, d), list.push(d);
  return { list, byFile };
}

export interface CallBinderOptions {
  /** Recall mode: the name-driven rules on top of the stated evidence (see the header). */
  recall?: boolean;
  /** Bind only call sites that reach one of these names (callerIndexForNames). */
  only?: ReadonlySet<string>;
  /** The resolve context the import pairs came from; the scan's own by default. */
  ctx?: ResolveContext;
}

// What one callee name resolves to under one reading; `local` when it is the
// caller's own file (a declaration line re-matched as a call then binds nothing).
interface Resolved {
  hit: BoundCall;
  local: boolean;
}

export interface CallBinder {
  /**
   * The binder for one file's call sites, or undefined when none of them can
   * reach an `only` name. `enclosing` is the declaration containing the site
   * when the caller already knows it; the binder finds it itself otherwise.
   */
  forFile(f: FileRecord): ((c: CallSite, enclosing?: CodeSymbol) => BoundCall | undefined) | undefined;
}

export function createCallBinder(scan: RepoScan, pairs: Set<string>, opts: CallBinderOptions = {}): CallBinder {
  const recall = opts.recall === true;
  const only = opts.only;
  const scope = createBindScope(scan, pairs, opts.ctx);

  // Declarations nested in a FUNCTION (a closure, a helper `def` inside a
  // test): they have a `parent`, but it is not a type, so they are not
  // members — a bare call reaches them, a receiver never does, and nothing
  // outside their function can name them at all. Read per file, on demand.
  let byRel: Map<string, FileRecord> | undefined;
  const fnParentsMemo = new Map<string, ReadonlySet<string>>();
  const noParents: ReadonlySet<string> = new Set();
  // The parents in `rel` that are functions, not types.
  const fnParentsOf = (rel: string): ReadonlySet<string> => {
    let parents = fnParentsMemo.get(rel);
    if (parents) return parents;
    const symbols = (byRel ??= new Map(scan.files.map((f) => [f.rel, f]))).get(rel)?.symbols ?? [];
    let set: Set<string> | undefined;
    let kindOf: Map<string, string> | undefined;
    for (const x of symbols) {
      if (x.parent === undefined) continue;
      if (!kindOf) {
        kindOf = new Map();
        for (const y of symbols) if (!kindOf.has(y.name)) kindOf.set(y.name, y.kind);
      }
      if (FUNCTION_KINDS.has(kindOf.get(x.parent) ?? "")) (set ??= new Set()).add(x.parent);
    }
    fnParentsMemo.set(rel, (parents = set ?? noParents));
    return parents;
  };
  const inFunction = (s: CodeSymbol): boolean => s.parent !== undefined && fnParentsOf(s.file).has(s.parent);
  const isMember = (s: CodeSymbol): boolean => s.parent !== undefined && !fnParentsOf(s.file).has(s.parent);

  // name → what another file can call by that name, per family. `exported`
  // is the table every binder always had; `hidden` holds what only a package
  // mate (Go, Java) or an importer (Python) can reach. Grouped per name on
  // first use: most names are never called, and grouping the TypeScript
  // repo's 300k declarations up front was a third of the binder's time.
  const byName = new Map<string, CodeSymbol[]>();
  for (const f of scan.files) {
    const reach = PRIVATE_REACH[familyOf(f.lang)] !== undefined;
    for (const s of f.symbols) {
      if (REFERENCE_KINDS.has(s.kind) || (!s.exported && !reach)) continue;
      if (only && !only.has(s.name)) continue;
      const list = byName.get(s.name);
      if (list) list.push(s);
      else byName.set(s.name, [s]);
    }
  }
  const tablesMemo = new Map<string, { exported: Tables; hidden: Tables } | null>();
  const tablesOf = (name: string): { exported: Tables; hidden: Tables } | null => {
    let t = tablesMemo.get(name);
    if (t !== undefined) return t;
    const list = byName.get(name);
    t = null;
    if (list) {
      t = { exported: newTables(), hidden: newTables() };
      for (const s of list) {
        if (s.exported) addTo(t.exported, s, isMember(s));
        else if (!inFunction(s)) addTo(t.hidden, s, isMember(s));
      }
    }
    tablesMemo.set(name, t);
    return t;
  };
  const exportedGroup = (name: string, family: string, pool: Pool): DefGroup<CodeSymbol> | undefined => {
    const t = tablesOf(name);
    return t ? groupOf(t.exported, name, family, pool) : undefined;
  };
  const hiddenGroup = (name: string, family: string, pool: Pool): DefGroup<CodeSymbol> | undefined => {
    const t = tablesOf(name);
    return t ? groupOf(t.hidden, name, family, pool) : undefined;
  };

  // Tail material (tests, examples, docs, scripts): nothing in the product
  // depends on it without saying so in an import.
  const tailMemo = new Map<string, boolean>();
  const isTail = (rel: string): boolean => {
    let t = tailMemo.get(rel);
    if (t === undefined) tailMemo.set(rel, (t = isTestPath(rel) || tierForPath(dirOf(rel) || "(root)") === 2));
    return t;
  };

  const forFile = (f: FileRecord): ((c: CallSite, enclosing?: CodeSymbol) => BoundCall | undefined) | undefined => {
    if (!f.calls?.length) return undefined;
    if (only && !f.calls.some((c) => only.has(c.name) || f.importAliases?.some((a) => a.local === c.name))) return undefined;
    const family = familyOf(f.lang);
    const shaped = !recall && SHAPED.has(family);
    const hiddenReach = PRIVATE_REACH[family];

    // Own declarations, by the shape of call that can reach them. `any` keeps
    // the first of each name (recall mode's shadowing rule, and a bare call
    // where the shape proves nothing), `free` the first that is not a member,
    // `member` the first member of any type. The rest is built on first use.
    const ownAny = new Map<string, CodeSymbol>();
    const ownFree = new Map<string, CodeSymbol>();
    const ownMember = new Map<string, CodeSymbol>();
    const ownTypes = new Set<string>(); // the types this file declares members of
    const fnParents = fnParentsOf(f.rel);
    const isOwnMember = (s: CodeSymbol): boolean => s.parent !== undefined && !fnParents.has(s.parent);
    for (const s of f.symbols) {
      if (REFERENCE_KINDS.has(s.kind)) continue;
      if (!ownAny.has(s.name)) ownAny.set(s.name, s);
      if (isOwnMember(s)) {
        if (!ownMember.has(s.name)) ownMember.set(s.name, s);
        ownTypes.add(s.parent!);
      } else if (!ownFree.has(s.name)) ownFree.set(s.name, s);
    }
    let usable: CodeSymbol[] | undefined; // what a site's enclosing declaration may be
    let ownMemberOf: Map<string, CodeSymbol> | undefined; // `${parent}\0${name}`
    let ownTypeByLower: Map<string, string | null> | undefined;
    const memberOf = (type: string, name: string): CodeSymbol | undefined => {
      if (!ownMemberOf) {
        ownMemberOf = new Map();
        for (const s of f.symbols) {
          if (REFERENCE_KINDS.has(s.kind) || !isOwnMember(s)) continue;
          const key = `${s.parent}\u0000${s.name}`;
          if (!ownMemberOf.has(key)) ownMemberOf.set(key, s);
        }
      }
      return ownMemberOf.get(`${type}\u0000${name}`);
    };
    const typeNamedLike = (receiver: string): string | null | undefined => {
      if (!ownTypes.size) return undefined;
      if (!ownTypeByLower) {
        ownTypeByLower = new Map();
        for (const t of ownTypes) {
          const k = t.toLowerCase();
          ownTypeByLower.set(k, ownTypeByLower.has(k) ? null : t);
        }
      }
      return ownTypeByLower.get(receiver.toLowerCase());
    };
    const aliases = scope.aliases(f);

    // Cross-file defs of `name` this file reaches by stated evidence.
    const corroborated = (name: string, pool: Pool): CodeSymbol[] => {
      const out = scope.reached(exportedGroup(name, family, pool), f, name);
      const priv = hiddenGroup(name, family, pool);
      if (priv && hiddenReach) {
        const seen = new Set(out.map((d) => d.file));
        for (const d of hiddenReach === "package" ? scope.reached(priv, f, name) : importedDefs(priv, scope.targets(f.rel))) {
          // A package-private def is visible to its own package only.
          if (hiddenReach === "package" && dirOf(d.file) !== dirOf(f.rel)) continue;
          if (d.file !== f.rel && !seen.has(d.file)) seen.add(d.file), out.push(d);
        }
      }
      return out;
    };
    // When the receiver names a type, its members come first: the type itself
    // (`Greeter.make()`, a declared `c *Context`), else one the receiver is
    // named after (`engine` → Engine).
    const preferParent = (list: CodeSymbol[], typeHint: string | undefined, receiver: string | undefined): CodeSymbol[] => {
      if (typeHint !== undefined && list.some((d) => d.parent === typeHint)) return list.filter((d) => d.parent === typeHint);
      const lower = receiver?.toLowerCase();
      if (lower !== undefined && list.some((d) => d.parent?.toLowerCase() === lower)) return list.filter((d) => d.parent?.toLowerCase() === lower);
      return list;
    };

    // `outside`: the receiver's declared type comes from a module outside the
    // repo (`t *testing.T`), so no declaration here is what it calls.
    type Shape = "bare" | "self" | "module" | "foreign" | "outside";
    // How a site's receiver reads: `selfType` is the type whose members this
    // file declares and the receiver is known to be; `typeHint` the type the
    // receiver names at all. A reading is shared by every site that reads the
    // same way, and memoizes what each callee name resolves to under it.
    interface Reading {
      shape: Shape;
      receiver?: string;
      selfType?: string;
      typeHint?: string;
      results: Map<string, Resolved | null>;
    }
    const reading = (shape: Shape, receiver?: string, selfType?: string, typeHint?: string): Reading =>
      ({ shape, receiver, selfType, typeHint, results: new Map() });
    const BARE = reading("bare");
    const OUTSIDE = reading("outside");
    // Readings that depend on the receiver alone, and those that also depend on
    // the enclosing declaration (a `self`, or a SHAPED family's typed header).
    const byReceiver = new Map<string, Reading>();
    const byEnclosing = new Map<CodeSymbol | null, Map<string, Reading>>();
    const read = (c: CallSite, enclosing: CodeSymbol | undefined): Reading => {
      const receiver = c.receiver;
      if (receiver === undefined) return BARE;
      let r = byReceiver.get(receiver);
      if (r) return r;
      const self = (t: string | undefined): Reading => reading("self", receiver, t, t);
      if (!SELF_NAMES.has(receiver)) {
        if (aliases.modules.has(receiver)) r = reading("module", receiver);
        else if (ownTypes.has(receiver)) r = self(receiver); // `Greeter.make()` next to Greeter
        else if (!SHAPED.has(family)) {
          // A variable named after a type this file declares: `store.get()`.
          const named = typeNamedLike(receiver);
          r = named ? self(named) : reading("foreign", receiver, undefined, aliases.names.get(receiver)?.name ?? receiver);
        }
        if (r) {
          byReceiver.set(receiver, r);
          return r;
        }
      }
      if (enclosing === undefined) {
        usable ??= f.symbols.filter((s) => !REFERENCE_KINDS.has(s.kind));
        enclosing = enclosingAmong(usable, c.line);
      }
      let inScope = byEnclosing.get(enclosing ?? null);
      if (!inScope) byEnclosing.set(enclosing ?? null, (inScope = new Map()));
      r = inScope.get(receiver);
      if (r) return r;
      r = readInScope(receiver, enclosing, self);
      inScope.set(receiver, r);
      return r;
    };
    // The part of `read` that depends on the enclosing declaration `e`.
    const readInScope = (receiver: string, e: CodeSymbol | undefined, self: (t: string | undefined) => Reading): Reading => {
      if (SELF_NAMES.has(receiver)) return self(e?.parent);
      // The enclosing header states the receiver's type: Go's method receiver
      // (`func (c *Context) …`), a parameter (`c *Context`, `app: Flask`).
      if (family === "go" && goReceiverVar(e) === receiver) return self(e!.parent);
      const d = e?.signature ? declaredType(e.signature, receiver) : undefined;
      if (d?.qualifier !== undefined && !recall && aliases.modules.get(d.qualifier) === null) return OUTSIDE;
      if (d !== undefined && ownTypes.has(d.type)) return self(d.type);
      // A variable named after a type this file declares: `engine := New()`.
      const named = d === undefined ? typeNamedLike(receiver) : undefined;
      if (named) return self(named);
      return reading("foreign", receiver, undefined, d?.type ?? aliases.names.get(receiver)?.name ?? receiver);
    };

    const resolve = (name: string, how: Reading): Resolved | null => {
      const { shape, receiver, selfType, typeHint } = how;
      if (shape === "outside") return null;
      // 1. The file's own declaration. A bare call reaches a top-level one
      //    (any, where the shape proves nothing), a call on the enclosing
      //    object a member of its type. A call on a module or on some other
      //    object never means this file's homonym: `io.Copy` is not
      //    `Context.Copy`, `this.map.get(k)` is not `Store.get`.
      let local: CodeSymbol | undefined;
      if (recall) local = ownAny.get(name);
      else if (shape === "bare") local = shaped ? ownFree.get(name) : ownAny.get(name);
      else if (shape === "self") {
        local = selfType !== undefined ? memberOf(selfType, name) : undefined;
        // `self.f()` may reach a member a same-file base class declares; a
        // stated or named type is exact.
        if (!local && receiver !== undefined && SELF_NAMES.has(receiver)) local = ownMember.get(name);
      }
      if (local) return only && !only.has(local.name) ? null : { hit: { def: local, corroborated: true }, local: true };

      // 2. What an import renames, and where it comes from.
      let restrict: string[] | null | undefined;
      let callee = name;
      if (shape === "bare") {
        const renamed = aliases.names.get(name);
        if (renamed) ({ name: callee, files: restrict } = renamed);
      } else if (shape === "module") restrict = aliases.modules.get(receiver!);
      if (only && !only.has(callee)) return null;
      // What the call's shape can reach (SHAPED families): a bare call or a
      // module qualifier a free function or type, a call on an object a
      // member. Through some other receiver Python may still name a module it
      // imported (`sessions.X()` after `from . import sessions`), Go never —
      // every Go qualifier is a known import.
      const pool: Pool = !shaped
        ? "any"
        : shape === "bare" || shape === "module"
          ? "free"
          : shape === "self" || family === "go"
            ? "member"
            : "member-first";
      // A guess never reaches a free function through a receiver.
      const guessPool: Pool = pool === "member-first" ? "member" : pool;

      if (restrict !== undefined) {
        // The import says exactly where the name comes from — outside the repo
        // (null) binds nothing.
        if (restrict === null) {
          if (!recall) return null;
        } else {
          const hits = scope.within(exportedGroup(callee, family, pool), restrict, callee);
          if (hiddenReach === "import") {
            for (const d of scope.within(hiddenGroup(callee, family, pool), restrict, callee)) if (!hits.includes(d)) hits.push(d);
          }
          const chosen = pickCandidate(f.rel, hits);
          if (chosen) return { hit: { def: chosen, corroborated: true }, local: false };
          if (hits.length) return null; // a proximity tie
          // An in-repo module that does not visibly declare the name. JS/TS
          // and Go state every export, so nothing does; a Python module also
          // gains attributes from star imports and assignments the extractor
          // never sees, so the ordinary rules below still get a say.
          if (!recall && STRICT.has(family)) return null;
        }
      }

      // 3. Everything the file reaches by stated evidence.
      const stated = preferParent(corroborated(callee, pool), typeHint, receiver);
      if (stated.length) {
        const chosen = pickCandidate(f.rel, stated);
        return chosen ? { hit: { def: chosen, corroborated: true }, local: false } : null;
      }

      // 4. Inference by name, where the language permits it at all.
      const group = exportedGroup(callee, family, recall ? "any" : guessPool);
      if (!group) return null;
      const cands = defsOutside(group, f.rel);
      if (!cands.length) return null;
      let guesses: CodeSymbol[] = [...cands];
      if (recall) {
        // JS/TS: a name defined exactly once in the family (issue #7).
        if (family === "js" && cands.length !== 1) return null;
      } else {
        if (STRICT.has(family)) return null;
        const tail = isTail(f.rel);
        // Nothing calls into a test file it does not import, and the product
        // never calls into tests, examples or scripts.
        guesses = guesses.filter((d) => !isTestCaseFile(d.file) && (tail || !isTail(d.file)));
      }
      const chosen = pickCandidate(f.rel, preferParent(guesses, typeHint, receiver));
      return chosen ? { hit: { def: chosen, corroborated: false }, local: false } : null;
    };

    return (c: CallSite, enclosing?: CodeSymbol): BoundCall | undefined => {
      const how = read(c, enclosing);
      let r = how.results.get(c.name);
      if (r === undefined) how.results.set(c.name, (r = resolve(c.name, how)));
      if (!r) return undefined;
      // A regex collector may re-match a declaration as a call to itself.
      if (r.local && r.hit.def.line === c.line) return undefined;
      return r.hit;
    };
  };

  return { forFile };
}
