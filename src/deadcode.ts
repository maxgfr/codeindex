// Dead-code candidates over the static index, in two honestly-labeled tiers:
// "unreferenced" — an exported definition no call site binds to AND no other
// file of its language names it (highest confidence); "uncalled" — other files
// name it (an import, a type position, a same-name call site no binding could
// settle, a base-class list) but no call site binds to it.
//
// WHAT COUNTS AS A REFERENCE. The tier used to be read off symbols.json's
// refs, which only records names that are exported by exactly one file AND
// distinctive (5+ chars with an internal capital, underscore or digit). For
// every other name the check was vacuous: flask's `Scaffold` (imported by four
// files, the base class of App and Blueprint) and `Blueprint` (constructed at
// 71 sites) landed in the high-confidence tier while `ScaffoldBase`, used the
// same way, did not. The evidence is now per candidate, from what the scan
// already holds for every file of the same language family: identifiers read
// by the AST, call-site names and receivers, imported names and renames, and
// base-class lists. Where that evidence is blind to a name (the AST keeps only
// 5+ char identifiers, and a regex-tier file keeps none), the other files are
// read once and tokenized before "unreferenced" is claimed.
//
// WHAT IS NEVER A CANDIDATE. Test files and tail material (examples, docs,
// fixtures, scripts — see modules.ts tierForPath) are roots: their symbols are
// consumed by a runner or a reader, not by the product. So is the package's
// public API: what a manifest's entry points (package.json main/exports/bin,
// pyproject scripts, a crate's lib.rs, every Python package `__init__.py`)
// declare or re-export, with the members and base classes of the classes they
// export. And names the LANGUAGE calls (Python dunders, Go `init`/`main`, a JS
// `constructor`), which no call site ever will.
//
// By default only callables are candidates: a property, a type or an interface
// is never "called", so for them the `uncalled` tier said nothing and they
// buried the functions (833 of 1,125 candidates on codeindex itself were
// properties). `kinds: "all"` puts them back, in the `unreferenced` tier only.
import { join } from "node:path";
import type { CodeSymbol, FileRecord } from "./types.js";
import type { RepoScan } from "./scan.js";
import { callerIndexFor, importPairsFor, resolveContextFor, symbolRefsFor } from "./derived.js";
import { familyOf, importTargets } from "./calls.js";
import { tierForPath } from "./modules.js";
import { goImplementations, resolveRelations, type ResolvedRelation } from "./relations.js";
import { overridePairs, type TypeRelation } from "./symbolgraph.js";
import { distToSrcCandidates, resolveImport, tolerantJsonParse, type ResolveContext } from "./resolve.js";
import { isTestPath } from "./tests-map.js";
import { readText } from "./walk.js";
import { byStr } from "./sort.js";

const REFERENCE_KINDS = new Set(["reexport", "reexport-all", "default"]);

// Kinds a call site can reach. A JS `const` joins them when its initializer is
// a function (see isCallable).
const CALLABLE_KINDS = new Set(["function", "method", "def", "constructor", "operator", "class", "macro"]);
const FN_INITIALIZER = /^[\w$]+\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\(|[\w$]+\s*=>)/;
const PY_LAMBDA = /^\w+\s*(?::[^=]*)?=\s*lambda\b/;

// Kinds that hold members: a public one makes its members public too.
const CONTAINER_KINDS = new Set(["class", "interface", "struct", "trait", "object", "enum", "record", "protocol", "module", "type"]);

// Fallback entry points, for a repo whose manifests name none: a basename that
// means "entry" in most ecosystems. Project-specific names (app, server,
// engine) used to be on this list and exempted, say, every method of flask's
// app.py.
const ENTRY_BASENAME = /(^|\/)(index|main|cli|mod|lib|__main__)\.[a-z]+$/;

// What the AST's identifier pass keeps (ast/extract.ts REF_IDENT_TEXT): a name
// it cannot hold has to be confirmed against the text.
const IDENT_VISIBLE = /^[A-Za-z_]\w{4,}$/;

const SEP = "\u0000";
const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

// One file to walk from, and the names wanted of it (undefined: every export).
type Step = { rel: string; names?: ReadonlySet<string> };

export interface DeadSymbol {
  name: string;
  file: string;
  line: number;
  kind: string;
  tier: "unreferenced" | "uncalled";
}

export interface DeadCodeOptions {
  /** "callable" (default): functions, methods, classes, function-valued consts. "all": every exported kind. */
  kinds?: "callable" | "all";
  /** Also report symbols of tail files (examples, docs, fixtures, scripts). Test files stay roots. */
  includeTail?: boolean;
}

// Tail material: modules.ts's tier-2 paths, plus Go's `testdata` trees, which
// the go tool itself never builds.
function isTail(rel: string): boolean {
  return tierForPath(dirOf(rel) || "(root)") === 2 || /(^|\/)testdata\//.test(rel);
}

function isCallable(s: CodeSymbol): boolean {
  if (CALLABLE_KINDS.has(s.kind)) return true;
  if (s.kind !== "const" || !s.signature) return false;
  const family = familyOf(s.lang);
  return family === "js" ? FN_INITIALIZER.test(s.signature) : family === "python" && PY_LAMBDA.test(s.signature);
}

// Names the language (or its runtime) calls on the program's behalf.
function isProtocolName(s: CodeSymbol): boolean {
  switch (familyOf(s.lang)) {
    case "python":
      return /^__\w+__$/.test(s.name);
    case "go":
      return s.name === "init" || s.name === "main";
    case "js":
      return s.name === "constructor";
    default:
      return false;
  }
}

export function findDeadCode(scan: RepoScan, opts: DeadCodeOptions = {}): DeadSymbol[] {
  const all = opts.kinds === "all";
  // Memoized per scan (src/derived.ts) and READ-ONLY here — this function
  // only .get()s from these structures, so sharing the cached objects is safe.
  const callers = callerIndexFor(scan);
  const pairs = importPairsFor(scan);
  const relations = resolveRelations(scan, pairs);
  const roots = publicRoots(scan, pairs, relations);
  const isCalled = (s: CodeSymbol): boolean => {
    // The qualified key FIRST: when several files export the same name, the
    // bare key holds the first-sorted def's entry, and the others live under
    // "name@file" only. Looking the bare key up first would answer with a
    // homonym from another file, fail the file check below, and flag a
    // symbol that IS called as dead.
    const entry = callers.get(`${s.name}@${s.file}`) ?? callers.get(s.name);
    return !!entry && entry.def.file === s.file && entry.callers.length > 0;
  };
  const dispatched = dispatchLiveness(scan, relations, (s) => isCalled(s) || roots.has(`${s.name}${SEP}${s.file}`));

  const candidates: CodeSymbol[] = [];
  for (const f of scan.files) {
    if (isTestPath(f.rel)) continue;
    if (!opts.includeTail && isTail(f.rel)) continue;
    for (const s of f.symbols) {
      if (!s.exported || REFERENCE_KINDS.has(s.kind) || isProtocolName(s)) continue;
      if (!all && !isCallable(s)) continue;
      if (roots.has(`${s.name}${SEP}${s.file}`) || isCalled(s) || dispatched(s)) continue;
      candidates.push(s);
    }
  }

  const referenced = referencedElsewhere(scan, candidates, relations);
  const out: DeadSymbol[] = [];
  for (const s of candidates) {
    const seen = referenced(s);
    // A non-callable is never "called": named anywhere, it is in use.
    if (seen && !isCallable(s)) continue;
    out.push({ name: s.name, file: s.file, line: s.line, kind: s.kind, tier: seen ? "uncalled" : "unreferenced" });
  }
  return out.sort((a, b) => byStr(a.tier, b.tier) || byStr(a.file, b.file) || a.line - b.line);
}

// Is method `s` reachable by dispatch? A call binds to the method its
// receiver's declared type names (`x.area()` on a `Shape` reaches
// `Shape/area`), so an override of a live method is live: `Square/area` is
// run by every call to `Shape/area`. The top of an override chain in a class
// with a base outside the repo may override THAT (a jinja loader's
// `get_source`), which the framework calls: live too. Go is left out of the
// second rule: its "bases" are embedded fields, and a method matching an
// outside interface (`Error`, `String`) is already at most "uncalled".
function dispatchLiveness(
  scan: RepoScan,
  relations: ResolvedRelation[],
  live: (s: CodeSymbol) => boolean,
): (s: CodeSymbol) => boolean {
  const typeRelations: TypeRelation[] = [...relations];
  for (const r of goImplementations(scan)) typeRelations.push({ ...r, kind: "implements" });
  const overridden = new Map<CodeSymbol, CodeSymbol[]>();
  for (const { sub, sup } of overridePairs(scan, typeRelations)) {
    const list = overridden.get(sub) ?? [];
    list.push(sup);
    overridden.set(sub, list);
  }
  // Types with a declared base that resolved nowhere in the repo.
  const resolvedCount = new Map<string, number>();
  for (const r of relations) {
    const k = `${r.from}${SEP}${r.fromFile}`;
    resolvedCount.set(k, (resolvedCount.get(k) ?? 0) + 1);
  }
  const external = new Set<string>();
  for (const f of scan.files) {
    if (familyOf(f.lang) === "go") continue;
    const declared = new Map<string, number>();
    for (const r of f.relations ?? []) declared.set(r.from, (declared.get(r.from) ?? 0) + 1);
    for (const [from, n] of declared) if (n > (resolvedCount.get(`${from}${SEP}${f.rel}`) ?? 0)) external.add(`${from}${SEP}${f.rel}`);
  }

  const memo = new Map<CodeSymbol, boolean>();
  const check = (s: CodeSymbol, seen: Set<CodeSymbol>): boolean => {
    const known = memo.get(s);
    if (known !== undefined) return known;
    const sups = overridden.get(s);
    let result: boolean;
    if (!sups) result = !!s.parent && external.has(`${s.parent}${SEP}${s.file}`);
    else {
      seen.add(s);
      result = sups.some((u) => live(u) || (!seen.has(u) && check(u, seen)));
    }
    memo.set(s, result);
    return result;
  };
  return (s) => !!s.parent && check(s, new Set());
}

// Does a file other than the declaring one name `s`? Built once for the whole
// candidate list: per family, the candidate names, and for each the first two
// files that name it — two distinct files always include one that is not the
// declaring file, whichever homonym asks.
function referencedElsewhere(
  scan: RepoScan,
  candidates: CodeSymbol[],
  relations: { to: string; toFile: string }[],
): (s: CodeSymbol) => boolean {
  const wanted = new Map<string, Map<string, string[]>>(); // family → name → files naming it
  for (const s of candidates) {
    const family = familyOf(s.lang);
    let names = wanted.get(family);
    if (!names) wanted.set(family, (names = new Map()));
    if (!names.has(s.name)) names.set(s.name, []);
  }
  // "" stands for "a base-class list": never the declaring file.
  const note = (names: Map<string, string[]> | undefined, name: string | undefined, rel: string): void => {
    if (name === undefined) return;
    const files = names?.get(name);
    if (files && files.length < 2 && files[files.length - 1] !== rel) files.push(rel);
  };
  const langOf = new Map<string, string>();
  // Families with a file the identifier pass never saw (regex tier).
  const identBlind = new Set<string>();
  for (const f of scan.files) {
    if (f.kind !== "code") continue;
    langOf.set(f.rel, f.lang);
    const family = familyOf(f.lang);
    const names = wanted.get(family);
    if (!names) continue;
    if (f.idents === undefined) identBlind.add(family);
    for (const id of f.idents ?? []) note(names, id, f.rel);
    for (const c of f.calls ?? []) {
      note(names, c.name, f.rel);
      note(names, c.receiver, f.rel);
    }
    for (const n of f.importedNames ?? []) note(names, n, f.rel);
    for (const a of f.importAliases ?? []) {
      note(names, a.name, f.rel);
      note(names, a.local, f.rel);
    }
    // A base-class list names the base in the subtype's own file too: being
    // extended is a use, wherever the subtype lives.
    for (const r of f.relations ?? []) note(names, r.to, "");
  }
  // Resolved inheritance, which reads through import renames
  // (`class Blueprint(SansioBlueprint)`).
  for (const r of relations) note(wanted.get(familyOf(langOf.get(r.toFile) ?? "")), r.to, "");
  // A doc naming the symbol (symbols.json refs) keeps the tier it always had.
  const docRefs = symbolRefsFor(scan);

  const seenBy = (s: CodeSymbol): boolean => {
    const files = wanted.get(familyOf(s.lang))?.get(s.name) ?? [];
    return files.some((rel) => rel !== s.file) || [...(docRefs.get(s.name) ?? [])].some((rel) => rel !== s.file);
  };

  // Names the evidence above cannot see, still unseen: confirm against the
  // text of the family's other files, read once. Comments and strings count —
  // the tier errs towards "uncalled".
  const blind = new Map<string, Set<string>>(); // family → names
  for (const s of candidates) {
    const family = familyOf(s.lang);
    if (seenBy(s) || (IDENT_VISIBLE.test(s.name) && !identBlind.has(family))) continue;
    let names = blind.get(family);
    if (!names) blind.set(family, (names = new Set()));
    names.add(s.name);
  }
  if (blind.size) {
    for (const f of scan.files) {
      if (f.kind !== "code") continue;
      const family = familyOf(f.lang);
      const names = blind.get(family);
      if (!names) continue;
      const text = readText(join(scan.root, f.rel));
      const token = family === "js" ? /[A-Za-z_$][\w$]*/g : /[A-Za-z_]\w*/g;
      const found = new Set<string>();
      for (const m of text.match(token) ?? []) if (names.has(m)) found.add(m);
      for (const name of found) note(wanted.get(family), name, f.rel);
    }
  }

  // Last, the declaring file itself, outside the declaration: a class listed
  // in a registry a few lines down (flask's `default_tags = [TagDict, …]`) or
  // a function handed over as a callback is in use. The identifier pass never
  // records a file's own names, so this is read from the text.
  const local = new Set<CodeSymbol>();
  const unseen = new Map<string, CodeSymbol[]>(); // file → still-unseen candidates
  for (const s of candidates) {
    if (seenBy(s)) continue;
    const list = unseen.get(s.file) ?? [];
    list.push(s);
    unseen.set(s.file, list);
  }
  for (const [rel, list] of unseen) {
    const names = new Set(list.map((s) => s.name));
    const token = familyOf(list[0]!.lang) === "js" ? /[A-Za-z_$][\w$]*/g : /[A-Za-z_]\w*/g;
    const linesOf = new Map<string, number[]>();
    readText(join(scan.root, rel))
      .split("\n")
      .forEach((text, i) => {
        for (const m of text.match(token) ?? []) if (names.has(m)) linesOf.set(m, [...(linesOf.get(m) ?? []), i + 1]);
      });
    for (const s of list) {
      const end = s.endLine ?? s.line;
      if ((linesOf.get(s.name) ?? []).some((n) => n < s.line || n > end)) local.add(s);
    }
  }
  return (s) => local.has(s) || seenBy(s);
}

// The symbols outside code can reach: `${name}\0${file}` for every exported
// declaration an entry point declares or re-exports (through named and `*`
// re-exports, a few hops deep), the members of every such container, and the
// supertypes (with their members) of every such type.
export function publicRoots(
  scan: RepoScan,
  pairs: Set<string>,
  relations: { from: string; fromFile: string; to: string; toFile: string }[],
): Set<string> {
  const ctx = resolveContextFor(scan);
  const byRel = new Map(scan.files.map((f) => [f.rel, f]));
  let frontier = manifestEntries(scan, ctx, byRel);
  if (!frontier.length) {
    for (const f of scan.files) if (f.kind === "code" && ENTRY_BASENAME.test(f.rel)) frontier.push({ rel: f.rel });
  }
  // Every Python package's `__init__.py` IS its public namespace: what it
  // declares or re-exports is importable from outside.
  for (const f of scan.files) if (f.rel === "__init__.py" || f.rel.endsWith("/__init__.py")) frontier.push({ rel: f.rel });

  const targets = importTargets(pairs);
  const roots = new Set<string>();
  const visited = new Set<string>();
  for (let depth = 0; depth < 5 && frontier.length; depth++) {
    const next: Step[] = [];
    for (const { rel, names } of frontier) {
      const key = `${rel}${SEP}${names ? [...names].sort(byStr).join(",") : "*"}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const f = byRel.get(rel);
      if (!f) continue;
      const onward = new Set<string>();
      for (const s of f.symbols) {
        if (s.kind === "reexport") {
          if (!names || names.has(s.name)) onward.add(s.name);
        } else if (s.kind === "reexport-all") {
          // `export * from './m'` is recorded as `* (./m)`: it passes on
          // whatever was asked of this file, and only to that module.
          const spec = /^\* \((.+)\)$/.exec(s.name)?.[1];
          const r = spec === undefined ? undefined : resolveImport(rel, f.ext, spec, ctx);
          if (r?.kind === "resolved") next.push({ rel: r.target, ...(names ? { names } : {}) });
        } else if (s.exported && s.kind !== "default" && (!names || names.has(s.name))) {
          roots.add(`${s.name}${SEP}${s.file}`);
        }
      }
      // A named re-export does not say which import it came from: every
      // import of the file is asked for those names.
      if (onward.size) for (const t of [...(targets.get(rel) ?? [])].sort(byStr)) next.push({ rel: t, names: onward });
    }
    frontier = next;
  }

  // Supertypes of public types, and members of public containers, to a fixpoint.
  const supers = new Map<string, string[]>();
  for (const r of relations) {
    const k = `${r.from}${SEP}${r.fromFile}`;
    const list = supers.get(k) ?? [];
    list.push(`${r.to}${SEP}${r.toFile}`);
    supers.set(k, list);
  }
  const members = new Map<string, string[]>(); // `${parent}\0${file}` → member keys
  for (const f of scan.files) {
    for (const s of f.symbols) {
      if (!s.parent) continue;
      const k = `${s.parent}${SEP}${s.file}`;
      const list = members.get(k) ?? [];
      list.push(`${s.name}${SEP}${s.file}`);
      members.set(k, list);
    }
  }
  const containers = new Set<string>();
  for (const f of scan.files) for (const s of f.symbols) if (CONTAINER_KINDS.has(s.kind)) containers.add(`${s.name}${SEP}${s.file}`);
  const queue = [...roots].sort(byStr);
  while (queue.length) {
    const k = queue.pop()!;
    const reach = [...(supers.get(k) ?? []), ...(containers.has(k) ? (members.get(k) ?? []) : [])];
    for (const r of reach) if (!roots.has(r)) roots.add(r), queue.push(r);
  }
  return roots;
}

// The code files a manifest names as entry points, sorted. A JS entry usually
// names build output (`./dist/index.js`, or a bundle like `scripts/cli.mjs`),
// so each also tries the source it came from: the dist→src remaps import
// resolution already uses, and `src/<basename>`. A Python script entry
// (`pkg.cli:main`) names one function of its module.
function manifestEntries(scan: RepoScan, ctx: ResolveContext, byRel: Map<string, FileRecord>): Step[] {
  const out = new Set<string>();
  const scripts = new Map<string, Set<string>>(); // module file → entry functions
  const isCode = (rel: string): boolean => byRel.get(rel)?.kind === "code";
  for (const f of scan.files) {
    const base = f.rel.slice(f.rel.lastIndexOf("/") + 1);
    const dir = dirOf(f.rel);
    if (base === "package.json") {
      const pkg = tolerantJsonParse(readText(join(scan.root, f.rel)));
      if (!pkg || typeof pkg !== "object") continue;
      const leaves: string[] = [];
      const collect = (v: unknown): void => {
        if (typeof v === "string") leaves.push(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === "object") Object.values(v).forEach(collect);
      };
      const p = pkg as Record<string, unknown>;
      for (const field of ["source", "main", "module", "types", "typings", "bin", "exports"]) collect(p[field]);
      if (typeof p.browser === "string") collect(p.browser);
      const from = dir ? `${dir}/package.json` : "package.json";
      for (const leaf of leaves) {
        const last = leaf.slice(leaf.lastIndexOf("/") + 1);
        // Code only: `./package.json` and a stylesheet are export targets too.
        if (leaf.includes("*") || (last.includes(".") && !/\.[cm]?[jt]sx?$/.test(last))) continue;
        const stem = last.replace(/(\.d)?\.[cm]?[jt]sx?$/, "");
        for (const cand of [leaf, ...distToSrcCandidates(leaf), `src/${stem}`]) {
          const r = resolveImport(from, ".ts", cand.startsWith(".") ? cand : `./${cand}`, ctx);
          if (r.kind === "resolved" && isCode(r.target)) out.add(r.target);
        }
      }
    } else if (base === "pyproject.toml") {
      // [project.scripts] / [project.gui-scripts] / [tool.poetry.scripts]:
      // `name = "pkg.module:function"`.
      const text = readText(join(scan.root, f.rel));
      const section = /^\[(?:project\.(?:gui-)?scripts|tool\.poetry\.scripts)\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm;
      for (const m of text.matchAll(section)) {
        for (const e of m[1]!.matchAll(/^\s*[\w.-]+\s*=\s*["']([\w.]+):(\w+)[\w.]*["']/gm)) {
          const r = resolveImport(dir ? `${dir}/pyproject.py` : "pyproject.py", ".py", e[1]!, ctx);
          if (r.kind !== "resolved" || !isCode(r.target)) continue;
          const fns = scripts.get(r.target) ?? new Set<string>();
          scripts.set(r.target, fns.add(e[2]!));
        }
      }
    }
  }
  for (const crate of ctx.rustCrates) if (crate.rootFile) out.add(crate.rootFile);
  const steps: Step[] = [...out].sort(byStr).map((rel) => ({ rel }));
  for (const rel of [...scripts.keys()].sort(byStr)) if (!out.has(rel)) steps.push({ rel, names: scripts.get(rel)! });
  return steps;
}

export interface CappedDeadCode {
  total: number;
  shown: number;
  truncated: true;
  candidates: DeadSymbol[];
}

// The list capped at `limit`, saying so: on a large repo it runs to thousands
// of entries, and a capped list that looks complete is worse than a shorter
// one that admits it. Additive — without a limit (or under it) the payload is
// the bare array it always was. Shared by the CLI's --limit and MCP's `limit`.
export function capDeadCode(all: DeadSymbol[], limit?: number): DeadSymbol[] | CappedDeadCode {
  if (limit === undefined || all.length <= limit) return all;
  return { total: all.length, shown: limit, truncated: true, candidates: all.slice(0, limit) };
}
