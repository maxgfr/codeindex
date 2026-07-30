// The grammar's OWN declared vocabulary as the denominator for "did we remember
// every construct?".
//
// WHY THIS EXISTS. Symbol extraction is a hand-written walk driven by tables
// (ast/specs.ts): a list of node types per grammar. Tables have a failure mode no
// test of the table can catch — a construct nobody listed simply does not exist,
// and the suite stays green. That is how TypeScript interface members, Rust trait
// method signatures and every `.d.ts` declaration went unindexed, and it is what
// ast/tags.ts also attacks, from the other side: tags.ts compares our OUTPUT
// against the grammar authors' own `tags.scm` on real source. This module never
// parses anything. It asks the compiled grammar what node types it declares and
// subtracts the ones our LangSpec mentions, so the question becomes a computable
// set difference that holds even for a construct no fixture in the repo contains.
//
// KNOWN LIMITATION, and it is not small. The numerator is the set of node types a
// spec KEYS ON. A construct handled only inside a whole-spec predicate is
// invisible to that: Python's `X = 1` (an `assignment` reached through
// `extraMembers`) and Ruby's `attr_reader` (likewise) are fully indexed yet count
// as uncovered here, because no table has `assignment` as a key. So
// `uncoveredDeclarative` is a list to ADJUDICATE, not a defect list — and a
// non-zero count is the normal state, never a build failure.
//
// Reported, never ratcheted: nothing in the indexing path imports this module, so
// a grammar that fails to load costs a `ready: false` row and nothing else.
import type { Language } from "web-tree-sitter";
import { allGrammarKeys, languageFor } from "./loader.js";
import { SPECS } from "./specs.js";
import { byStr } from "../sort.js";

/**
 * A node type name that looks like it DECLARES something, judged from the name
 * alone. Exported so the filter is reviewable rather than buried: every entry
 * here widens the denominator, and a bad entry manufactures a fake recall gap.
 *
 * `_body$` and `_declarator$` are in because they are the container/indirection
 * shapes our specs really do key on (`class_body`, `enum_body`, C's
 * `function_declarator`); `_spec$` / `_elem$` / `_item$` because Go and Rust spell
 * their members that way (`type_spec`, `method_elem`, `function_item`);
 * `_signature$` because a TypeScript `.d.ts` is nothing else, and it is what
 * surfaces the still-unindexed `call_signature` / `index_signature`.
 */
export const DECLARATIVE_TYPE = /declaration|definition|_spec$|_item$|_signature$|_elem$|_body$|_declarator$/;

/**
 * A SUPERTYPE whose members are all declaration-ish, so its `subtypes()` list can
 * be taken wholesale. This catches the types a name test misses: go's
 * `short_var_declaration` and `import_spec` arrive this way, as do javascript's
 * declaration forms via its `declaration` supertype.
 *
 * `statement` is knowingly generous — it drags `while_statement`,
 * `break_statement` and friends into the declarative set for c, c_sharp, php,
 * javascript and lua, which is most of what those languages' uncovered lists
 * contain. That is why the RAW numbers are reported alongside and why this list is
 * adjudicated by a human, never enforced by a threshold.
 */
export const DECLARATIVE_SUPERTYPE = /declaration|definition|statement|item/;

export interface GrammarCoverage {
  key: string;
  /** Grammar loaded? When false every other field is zero/empty — see `blank`. */
  ready: boolean;
  /** Denominator: distinct named+visible type names UNION the supertype names. */
  grammarTypes: number;
  /** Distinct node types our LangSpec keys on. */
  specKeys: number;
  coveredRaw: number;
  /** `coveredRaw / grammarTypes`, 4dp. A FLOOR, not a gap — see the filter below. */
  rawRatio: number;
  declarativeTypes: number;
  coveredDeclarative: number;
  declarativeRatio: number;
  /** Declaration-ish node types the grammar declares that NO spec hook references. */
  uncoveredDeclarative: string[];
  /** Spec keys the grammar does not declare at all — grammar-bump drift. */
  unknownKeys: string[];
}

const blank = (key: string): GrammarCoverage => ({
  key,
  ready: false,
  grammarTypes: 0,
  specKeys: 0,
  coveredRaw: 0,
  rawRatio: 0,
  declarativeTypes: 0,
  coveredDeclarative: 0,
  declarativeRatio: 0,
  uncoveredDeclarative: [],
  unknownKeys: [],
});

// Fixed precision so a report diff shows a real movement rather than float noise.
const ratio = (n: number, d: number): number => (d === 0 ? 0 : Number((n / d).toFixed(4)));

/**
 * The node types a LangSpec KEYS ON, from exactly the eleven hooks whose keys are
 * node types.
 *
 * `lang`, `exported`, `assignments`, `docstring`, `docFrom`, `sectionVisibility`,
 * `privateMember`, `publicMember`, `skipCall` and `extraMembers` are deliberately
 * absent: they are whole-spec predicates and booleans, not maps keyed by node
 * type, so there is nothing in them to intersect with the grammar's vocabulary.
 * That is the source of the header's limitation — a construct reached only
 * through `extraMembers` or `assignments` contributes no key here.
 */
function specKeysFor(key: string): Set<string> {
  const out = new Set<string>();
  const spec = SPECS[key];
  if (!spec) return out;
  const records = [
    spec.defs,
    spec.imports,
    spec.calls,
    spec.nameFrom,
    spec.kindFrom,
    spec.parentFrom,
    spec.publicMembersIn,
    spec.bareMembers,
    spec.relationsFrom,
  ];
  for (const record of records) if (record) for (const k of Object.keys(record)) out.add(k);
  // The two Sets, which carry their node types as values rather than keys.
  for (const k of spec.containers) out.add(k);
  if (spec.exportMarkers) for (const k of spec.exportMarkers) out.add(k);
  return out;
}

/** The grammar's declared vocabulary, and the declaration-ish slice of it. */
function vocabulary(language: Language): { all: Set<string>; declarative: Set<string> } {
  const all = new Set<string>();
  // NAMES, not ids, throughout. `Language.types` is indexed by type id and
  // contains DUPLICATES, because an alias shares its name with the node it
  // renames: python has 128 named+visible ids but only 123 distinct names. Ratios
  // computed over ids would therefore differ from ratios over the names a spec
  // can actually write, so everything below is deduped by name.
  const count = language.nodeTypeCount;
  for (let id = 0; id < count; id++) {
    if (!language.nodeTypeIsNamed(id) || !language.nodeTypeIsVisible(id)) continue;
    const name = language.nodeTypeForId(id);
    if (name) all.add(name);
  }

  // Supertypes are INVISIBLE to the sweep above — measured against
  // web-tree-sitter 0.26.11, a supertype id answers false to `nodeTypeIsNamed`
  // AND to `nodeTypeIsVisible`, so neither flag would let one through. They are
  // real vocabulary (`declaration` and `statement` in javascript, `_declarator` in
  // c, `_simple_statement` in go, `expression`/`pattern` in python), and they are
  // what the declarative filter harvests subtypes from, so union them in
  // explicitly. Only 8 of the 21 shipped grammars declare any at all — for
  // typescript, rust, java, scala and the rest `supertypes` is `[]` and this loop
  // is a no-op, which is why the name test below has to carry those languages.
  //
  // Deliberately absent from all of this: `ERROR` (not in the named+visible set)
  // and id 0, which is the zero-width `end` marker. Neither is a construct a spec
  // keys on, so counting them would only inflate the denominator.
  const subtypeNames = new Set<string>();
  for (const id of language.supertypes) {
    const name = language.nodeTypeForId(id);
    if (!name) continue;
    all.add(name);
    if (!DECLARATIVE_SUPERTYPE.test(name)) continue;
    for (const sub of language.subtypes(id)) {
      const subName = language.nodeTypeForId(sub);
      if (subName) subtypeNames.add(subName);
    }
  }

  // The RAW ratio is a floor rather than a gap: the denominator above includes
  // `identifier`, `int_literal`, `comment`, `pointer_type`, `slice_type` — things
  // no hand-written spec will ever key on. This is the slice worth adjudicating.
  // Filtered from `all` so it stays a subset of the reported denominator.
  const declarative = new Set<string>();
  for (const name of all) if (subtypeNames.has(name) || DECLARATIVE_TYPE.test(name)) declarative.add(name);
  return { all, declarative };
}

/**
 * How much of one grammar's declared vocabulary its LangSpec mentions. Returns a
 * `ready: false` row of zeros when the grammar is not loaded (extended tier
 * before a `grammars pull`, or a key that does not exist) — this never throws,
 * because it is a reporting path and a broken grammar must not take a caller down.
 */
export function grammarCoverage(key: string): GrammarCoverage {
  const language = languageFor(key);
  if (!language) return blank(key);
  try {
    const { all, declarative } = vocabulary(language);
    const keys = specKeysFor(key);
    let coveredRaw = 0;
    let coveredDeclarative = 0;
    for (const k of keys) {
      if (all.has(k)) coveredRaw++;
      if (declarative.has(k)) coveredDeclarative++;
    }
    return {
      key,
      ready: true,
      grammarTypes: all.size,
      specKeys: keys.size,
      coveredRaw,
      rawRatio: ratio(coveredRaw, all.size),
      declarativeTypes: declarative.size,
      coveredDeclarative,
      declarativeRatio: ratio(coveredDeclarative, declarative.size),
      uncoveredDeclarative: [...declarative].filter((n) => !keys.has(n)).sort(byStr),
      unknownKeys: [...keys].filter((n) => !all.has(n)).sort(byStr),
    };
  } catch {
    // A grammar whose introspection API disagrees with the installed
    // web-tree-sitter reports nothing rather than breaking the report.
    return blank(key);
  }
}

/** One row per shipped grammar key, in key order. */
export function coverageForAll(): GrammarCoverage[] {
  return allGrammarKeys()
    .slice()
    .sort(byStr)
    .map(grammarCoverage);
}
