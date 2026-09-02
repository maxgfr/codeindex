// Values with no single source of truth.
//
// The defect this reports is not "a string appears twice" — that is normal and
// harmless. It is the shape a reviewer finds by hand and a compiler never
// finds at all: ONE value, written out in many places, where a constant
// holding it already exists and some call sites use it while others rewrite
// the literal. Change the value and the helper's users follow; the literal's
// users silently do not. Nothing fails, and the two halves drift apart.
//
// Reported in three honestly-labeled tiers, the same doctrine `deadcode` uses
// for `unreferenced` vs `uncalled` — the analysis says which case it found
// rather than flattening them into one confidence-free list:
//
//   uncentralized  the value recurs across files and NO constant holds it
//   bypassed       a constant holds it, and other files rewrite it anyway
//   competing      two or more DIFFERENT constants hold the same value
//
// `bypassed` and `competing` are the actionable ones: the first says a helper
// exists and is being ignored, the second says centralization was attempted
// more than once and nobody won.
import type { CodeLiteral, CodeSymbol, LiteralDuplication, LiteralSite } from "./types.js";
import type { RepoScan } from "./scan.js";
import { isTestPath } from "./tests-map.js";
import { byStr } from "./sort.js";

// Persisted shapes live in types.ts (its stated job); re-exported here so the
// analytic reads as one module to a consumer.
export type { LiteralDuplication, LiteralSite };

// How many duplications ride along on graph.json. Same doctrine as
// SURPRISE_CAP: the graph carries a readable headline, `codeindex literals`
// carries everything.
export const LITERAL_DUPLICATION_CAP = 24;

export interface LiteralFamily {
  // Longest shared path-like prefix of the group's values.
  prefix: string;
  members: LiteralDuplication[];
  files: number;
  count: number;
}

export interface LiteralsReport {
  duplications: LiteralDuplication[];
  families: LiteralFamily[];
}

export interface LiteralsOptions {
  // Minimum distinct files an occurrence must span. 1 would report every value
  // written twice in one file, which is a local style question, not a source-of
  // -truth one.
  minFiles?: number;
  minCount?: number;
  // Include test files. Off by default: a test restating a value is usually
  // asserting it on purpose, and including them buries the production signal.
  includeTests?: boolean;
  kinds?: ReadonlySet<CodeLiteral["kind"]>;
}

const DEFAULTS = { minFiles: 2, minCount: 3 };

// Declaration kinds that count as "a constant holding this value". A `let` or a
// function parameter is not a source of truth; an exported const/enum member is.
const HOLDER_KINDS = new Set(["const", "constant", "variable", "enum", "enumerator", "property", "field", "static"]);

// How many lines a declaration may span and still be read as "the constant
// holding this value". A one-liner is obviously one; a small lookup table still
// is. A 40-line zod schema that happens to contain "asc" is NOT a source of
// truth for "asc" — it merely mentions it — and counting it made every generic
// token in the repo look like a competing definition.
const MAX_HOLDER_SPAN = 12;

// A value needs enough identity to be worth centralizing. `siren`, `year`,
// `name`, `type`, `asc` recur in dozens of unrelated files because they are
// vocabulary, not shared constants: nobody would import them, and reporting
// them buries the paths, keys and thresholds that people really do duplicate.
// A separator (`/ : . - _`) marks a compound value — a path, a namespaced key,
// a dotted identifier — which is worth reporting at any length.
const DISTINCTIVE_MIN_LEN = 6;
const HAS_SEPARATOR = /[/:._-]/;

function isDistinctive(value: string, kind: CodeLiteral["kind"]): boolean {
  if (kind !== "string") return true;
  return value.length >= DISTINCTIVE_MIN_LEN || HAS_SEPARATOR.test(value);
}

// Path-ish values are the ones worth grouping into families: routes, storage
// key namespaces, URL prefixes. A sentence of French UI copy shares a prefix
// with nothing and would only produce noise families.
const PATH_LIKE = /^[/@a-z0-9][\w./:@-]*$/i;
const FAMILY_MIN_MEMBERS = 2;
const FAMILY_MIN_PREFIX = 4;

// `export const getPath = () => "/a/b"` is a FUNCTION that returns the value,
// not a constant that holds it — counting it as a holder would report every
// helper as a competing source of truth and invert the finding. A lookup table
// (`export const ROUTES = { compliance: "/a/b" }`) genuinely is one, so only
// function-valued initializers are excluded, not compound ones.
// Matches the HEADER, not the whole initializer: `signature` is capped at the
// declaration header, so `const onStart = async () => { … }` arrives as
// `onStart = async ()` with no `=>` to key on. Requiring the arrow missed every
// multi-line handler and reported it as a source of truth for the paths in its
// body.
const FUNCTION_RHS = /^\s*(?:async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)/;

function isFunctionValued(signature: string | undefined): boolean {
  if (!signature) return false;
  // First `=` that is an assignment, not part of `=>`, `==`, `<=`, `>=`, `!=`.
  for (let i = 0; i < signature.length; i++) {
    if (signature[i] !== "=") continue;
    if (signature[i + 1] === "=" || signature[i + 1] === ">") continue;
    if ("=!<>+-*/%&|^".includes(signature[i - 1] ?? "")) continue;
    return FUNCTION_RHS.test(signature.slice(i + 1));
  }
  return false;
}

// A file's symbols that can hold a literal at all — the kind, function-valued
// and span filters are properties of the SYMBOL, so they are applied once per
// file here rather than once per (literal × symbol) inside holderFor, which
// ran the signature regex L×S times on a file with L literals and S symbols.
// Order is preserved, so holderFor's innermost-wins tie-break is unchanged.
function holderCandidates(symbols: CodeSymbol[]): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  for (const s of symbols) {
    if (!HOLDER_KINDS.has(s.kind)) continue;
    if (isFunctionValued(s.signature)) continue;
    if ((s.endLine ?? s.line) - s.line > MAX_HOLDER_SPAN) continue;
    out.push(s);
  }
  return out;
}

function holderFor(candidates: CodeSymbol[], line: number): CodeSymbol | undefined {
  // A literal sitting inside a constant's declaration span IS that constant's
  // value. This span join needs no new extraction: both tiers already report a
  // symbol's line, and the AST tier reports endLine. It is also why the feature
  // works without grammars — a regex-tier symbol with no endLine still matches
  // its own declaration line.
  //
  // NOT limited to exported constants. A module-private constant that other
  // files rewrite by hand is the sharpest form of this defect, not a lesser
  // one: the value has an owner AND that owner is unreachable, so every other
  // call site had no choice but to duplicate it. Requiring `exported` here
  // silently reclassified exactly that case as "uncentralized" and lost the
  // fact that a helper already exists. `holderExported` keeps the distinction
  // visible instead of encoding it as absence.
  let best: CodeSymbol | undefined;
  for (const s of candidates) {
    const end = s.endLine ?? s.line;
    if (line < s.line || line > end) continue;
    // Innermost wins: a const nested in an exported object literal is the
    // tighter holder.
    if (!best || s.line > best.line) best = s;
  }
  return best;
}

export function findLiteralDuplications(scan: RepoScan, opts: LiteralsOptions = {}): LiteralsReport {
  const minFiles = opts.minFiles ?? DEFAULTS.minFiles;
  const minCount = opts.minCount ?? DEFAULTS.minCount;

  // value+kind → occurrences. Keyed on both so the number 5 and the string "5"
  // never merge into one bogus finding.
  const groups = new Map<string, { value: string; kind: CodeLiteral["kind"]; sites: LiteralSite[] }>();

  for (const f of scan.files) {
    if (!f.literals?.length) continue;
    if (!opts.includeTests && isTestPath(f.rel)) continue;
    let holders: CodeSymbol[] | undefined; // this file's holder candidates, built on first use
    for (const lit of f.literals) {
      if (opts.kinds && !opts.kinds.has(lit.kind)) continue;
      if (!isDistinctive(lit.value, lit.kind)) continue;
      const key = `${lit.kind}\u0000${lit.value}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { value: lit.value, kind: lit.kind, sites: [] }));
      const holder = holderFor((holders ??= holderCandidates(f.symbols)), lit.line);
      g.sites.push(
        holder
          ? { file: f.rel, line: lit.line, holder: holder.name, holderExported: holder.exported }
          : { file: f.rel, line: lit.line },
      );
    }
  }

  const duplications: LiteralDuplication[] = [];
  for (const g of groups.values()) {
    const files = new Set(g.sites.map((s) => s.file));
    if (files.size < minFiles || g.sites.length < minCount) continue;

    const holders = g.sites.filter((s) => s.holder);
    const literals = g.sites.filter((s) => !s.holder);
    const distinctHolderNames = new Set(holders.map((h) => h.holder!));
    const distinctHolders = new Set(holders.map((h) => `${h.file}\u0000${h.holder}`));

    // A value only ever written inside constants, in different files, is two
    // (or more) competing sources of truth — the "three centralization
    // attempts that ignore each other" case.
    let tier: LiteralDuplication["tier"] =
      distinctHolders.size >= 2 ? "competing" : holders.length > 0 ? "bypassed" : "uncentralized";

    // Numeric equality is not semantic identity. Two constants that both equal
    // 4 — MAX_CSE_FILES and QUARTILE_COUNT — are different concepts sharing a
    // value, not rival definitions of one, and a long distinctive STRING
    // recurring is evidence of sameness in a way a small integer never is. So a
    // number is reported only as `bypassed`, and only when a single named
    // constant owns it: that is the honest claim ("you already have a name for
    // this") and it still catches the case that matters most — a threshold
    // declared in code and restated in a config file no compiler reads.
    if (g.kind === "number") {
      if (distinctHolderNames.size !== 1 || literals.length === 0) continue;
      tier = "bypassed";
    }

    // A single holder with nothing bypassing it is a constant used correctly.
    if (tier === "bypassed" && literals.length === 0) continue;

    duplications.push({
      value: g.value,
      kind: g.kind,
      tier,
      holders: holders.sort(siteOrder),
      literals: literals.sort(siteOrder),
      files: files.size,
      count: g.sites.length,
    });
  }

  duplications.sort(
    (a, b) => tierRank(a.tier) - tierRank(b.tier) || b.files - a.files || b.count - a.count || byStr(a.value, b.value),
  );
  return { duplications, families: groupFamilies(duplications) };
}

function siteOrder(a: LiteralSite, b: LiteralSite): number {
  return byStr(a.file, b.file) || a.line - b.line;
}

// Actionability order, not severity theatre: a bypassed helper and competing
// helpers each name a fix; an uncentralized value only names a decision.
function tierRank(t: LiteralDuplication["tier"]): number {
  return t === "competing" ? 0 : t === "bypassed" ? 1 : 2;
}

// Values sharing a path prefix are one problem, not N. Without this an app
// with forty route literals reports forty findings and reads as noise; with
// it, the namespace surfaces once and the forty sit underneath it.
function groupFamilies(dups: LiteralDuplication[]): LiteralFamily[] {
  const byPrefix = new Map<string, LiteralDuplication[]>();
  for (const d of dups) {
    if (d.kind !== "string" || !PATH_LIKE.test(d.value)) continue;
    const prefix = pathPrefix(d.value);
    if (!prefix) continue;
    const list = byPrefix.get(prefix);
    if (list) list.push(d);
    else byPrefix.set(prefix, [d]);
  }

  const families: LiteralFamily[] = [];
  for (const [prefix, members] of byPrefix) {
    if (members.length < FAMILY_MIN_MEMBERS) continue;
    const files = new Set<string>();
    let count = 0;
    for (const m of members) {
      for (const s of [...m.holders, ...m.literals]) files.add(s.file);
      count += m.count;
    }
    families.push({ prefix, members, files: files.size, count });
  }
  families.sort((a, b) => b.files - a.files || b.count - a.count || byStr(a.prefix, b.prefix));
  return families;
}

// The value's namespace ROOT, not its parent path: `/a/b/c` → `/a`, and
// `egapro:cse-funnel` → `egapro`. Keying on the parent would put
// `/decl/etape/1` and `/decl/parcours/x` in different families and defeat the
// purpose — the whole point is that one namespace reports as one finding.
// `:` is a separator too, because storage keys namespace with it.
function pathPrefix(value: string): string | undefined {
  const body = value.startsWith("/") ? value.slice(1) : value;
  const cut = body.search(/[/:]/);
  if (cut <= 0) return undefined;
  const prefix = (value.startsWith("/") ? "/" : "") + body.slice(0, cut);
  return prefix.length >= FAMILY_MIN_PREFIX ? prefix : undefined;
}
