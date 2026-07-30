import { describe, it, expect } from "vitest";
import { allGrammarKeys } from "../src/ast/loader.js";
import {
  coverageForAll,
  grammarCoverage,
  DECLARATIVE_SUPERTYPE,
  DECLARATIVE_TYPE,
} from "../src/ast/grammar-coverage.js";

// Grammars are pre-warmed by tests/setup.ts, so every shipped key is loaded here.
//
// These assert PROPERTIES of the metric, never a frozen number: the ratios move
// whenever a grammar is bumped OR a spec grows, and a test that pins them would
// fail on the good change as loudly as on the bad one. The frozen numbers live in
// the quality baseline, which reviews movement instead of forbidding it.
describe("grammar coverage", () => {
  const reports = coverageForAll();

  it("reports one row per shipped grammar, all of them loaded", () => {
    expect(reports.map((r) => r.key)).toEqual([...allGrammarKeys()].sort());
    // A `ready: false` here would mean tests/setup.ts stopped warming a grammar —
    // in which case the whole suite is silently measuring the regex tier.
    for (const r of reports) expect(r.ready, `grammar "${r.key}" not loaded`).toBe(true);
  });

  it("has a non-empty denominator and numerator for every grammar", () => {
    for (const r of reports) {
      expect(r.grammarTypes, r.key).toBeGreaterThan(0);
      // Zero spec keys would mean the LangSpec lookup broke, not that a language
      // declares nothing — every spec has at least `defs` and `containers`.
      expect(r.specKeys, r.key).toBeGreaterThan(0);
    }
  });

  it("keeps both ratios inside [0,1]", () => {
    for (const r of reports) {
      expect(r.rawRatio, r.key).toBeGreaterThanOrEqual(0);
      expect(r.rawRatio, r.key).toBeLessThanOrEqual(1);
      expect(r.declarativeRatio, r.key).toBeGreaterThanOrEqual(0);
      expect(r.declarativeRatio, r.key).toBeLessThanOrEqual(1);
    }
  });

  it("counts covered types as an intersection of both sides", () => {
    for (const r of reports) {
      // An intersection can exceed neither operand. `coveredRaw > specKeys` would
      // mean double-counting a duplicated grammar type name (Language.types
      // repeats a name across alias ids), which is the bug the name Set prevents.
      expect(r.coveredRaw, r.key).toBeLessThanOrEqual(r.specKeys);
      expect(r.coveredRaw, r.key).toBeLessThanOrEqual(r.grammarTypes);
      expect(r.coveredDeclarative, r.key).toBeLessThanOrEqual(r.coveredRaw);
      // The declarative set is a FILTER over the denominator, not a separate
      // vocabulary — a subtype pulled in from a supertype must already be in it.
      expect(r.declarativeTypes, r.key).toBeLessThanOrEqual(r.grammarTypes);
    }
  });

  it("accounts for every spec key exactly once", () => {
    for (const r of reports) expect(r.coveredRaw + r.unknownKeys.length, r.key).toBe(r.specKeys);
  });

  it("accounts for every declarative type exactly once", () => {
    for (const r of reports) {
      expect(r.coveredDeclarative + r.uncoveredDeclarative.length, r.key).toBe(r.declarativeTypes);
    }
  });

  it("is deterministic", () => {
    // The whole point is a diffable report; a Set-iteration order leaking into the
    // output would make every rebuild look like a change.
    expect(grammarCoverage("typescript")).toEqual(grammarCoverage("typescript"));
    expect(coverageForAll()).toEqual(reports);
  });

  it("sorts both lists with the locale-independent comparator", () => {
    for (const r of reports) {
      expect(r.uncoveredDeclarative, r.key).toEqual([...r.uncoveredDeclarative].sort());
      expect(r.unknownKeys, r.key).toEqual([...r.unknownKeys].sort());
    }
  });

  // Every spec key the grammar does not declare, with the reason it is deliberate.
  // Pinned as an exact map so a NEW entry — the real signal, a grammar bump that
  // renamed or removed a node type our walk still keys on — fails this test,
  // while these two known, documented cases do not.
  const EXPECTED_UNKNOWN_KEYS: Record<string, string[]> = {
    // Cross-version compatibility, on purpose: interface method sets are
    // `method_spec` through tree-sitter-go 0.22 and `method_elem` from 0.23. Both
    // are listed in the spec so a bump in either direction cannot silently drop
    // every interface method (src/ast/specs.ts:391-394). The grammar we ship is
    // 0.25, so only the old name is unknown to it.
    go: ["method_spec"],
    // The `javascript` spec is `{ ...TS_SPEC }` with `defs` replaced
    // (src/ast/specs.ts:341-352), so it inherits TypeScript-only `containers`,
    // `exportMarkers`, `bareMembers` and `relationsFrom` keys that the JavaScript
    // grammar has no equivalent for. Harmless — a node type the grammar never
    // produces is a table entry the walk never reads — and cheaper than
    // maintaining a second hand-copied set of tables.
    javascript: [
      "abstract_class_declaration",
      "ambient_declaration",
      "call_signature",
      "construct_signature",
      "enum_body",
      "function",
      "index_signature",
      "interface_body",
      "interface_declaration",
      "object_type",
    ],
    // `function` is the PRE-0.21 grammar name for what tree-sitter-javascript now
    // calls `function_expression`. It is kept for the same cross-version reason
    // `FUNCTION_VALUE_TYPES` in src/ast/specs.ts lists both spellings: a repo
    // pinned to an older grammar still needs the older name, and a table entry
    // for a node type the grammar never produces is one the walk never reads.
    // Listed here so a reader knows it is deliberate rather than drift — which is
    // exactly the distinction this oracle exists to make.
    tsx: ["function"],
    typescript: ["function"],
  };

  it("has no unexplained unknown spec keys", () => {
    const actual: Record<string, string[]> = {};
    for (const r of reports) if (r.unknownKeys.length) actual[r.key] = r.unknownKeys;
    expect(actual).toEqual(EXPECTED_UNKNOWN_KEYS);
  });

  it("degrades to ready:false for a grammar that is not loaded, without throwing", () => {
    const r = grammarCoverage("nope");
    expect(r).toEqual({
      key: "nope",
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
  });

  it("keeps the two filter regexes stateless", () => {
    // A `/g` or `/y` flag on a module-level regex makes `.test` advance lastIndex,
    // so every other call returns false and the denominator would depend on Set
    // iteration order. The repeated assertion below IS the test.
    expect(DECLARATIVE_TYPE.global).toBe(false);
    expect(DECLARATIVE_SUPERTYPE.global).toBe(false);
    expect(DECLARATIVE_TYPE.test("function_declaration")).toBe(true);
    expect(DECLARATIVE_TYPE.test("function_declaration")).toBe(true);
    expect(DECLARATIVE_TYPE.test("identifier")).toBe(false);
  });

  // Elixir is the one grammar whose vocabulary contains nothing declaration-ish at
  // all: it declares through macro CALLS (`defmodule`, `def`, `defstruct`), so its
  // node types are `call`, `arguments`, `stab_clause`, `do_block` — no
  // `*_declaration`, no `*_definition`, and no declarative supertype to harvest.
  // Its declarativeRatio is 0/0 and carries no information; the raw row is all
  // this metric can say about it. Pinned so the day a grammar bump gives Elixir
  // real declaration nodes, this test says so.
  const NO_DECLARATIVE_VOCABULARY = new Set(["elixir"]);

  it("harvests declaration-ish types for every grammar that has any", () => {
    for (const r of reports) {
      if (NO_DECLARATIVE_VOCABULARY.has(r.key)) {
        expect(r.declarativeTypes, r.key).toBe(0);
        expect(r.declarativeRatio, r.key).toBe(0);
      } else {
        expect(r.declarativeTypes, r.key).toBeGreaterThan(0);
      }
    }
  });

  it("unions the supertype names into the denominator", () => {
    // A supertype id answers false to BOTH nodeTypeIsNamed and nodeTypeIsVisible,
    // so the id sweep cannot see one: C's `_declarator` is in the denominator only
    // because Language.supertypes is unioned in. Go's `_simple_statement` proves
    // the other half — it matches no name pattern, so it is in the DECLARATIVE
    // slice only as a subtype harvested from the `_statement` supertype.
    expect(grammarCoverage("c").uncoveredDeclarative).toContain("_declarator");
    expect(grammarCoverage("go").uncoveredDeclarative).toContain("_simple_statement");
    // And the alias-duplicate gotcha: python has 128 named+visible ids but only
    // 123 distinct names, so a denominator counted by id would read 128.
    expect(grammarCoverage("python").grammarTypes).toBeLessThan(128);
  });
});
