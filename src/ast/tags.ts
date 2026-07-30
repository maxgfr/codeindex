// The grammar's OFFICIAL view of what a file declares, via its published
// `queries/tags.scm` and tree-sitter's Query API.
//
// WHY THIS EXISTS. Symbol extraction is a hand-written walk (ast/specs.ts): a
// table of node types per grammar. Tables have a failure mode that no test of
// the table can catch — a construct nobody listed simply does not exist, and the
// suite stays green. That is exactly how TypeScript interface members, Rust
// trait method signatures and every `.d.ts` declaration went unindexed.
//
// `tags.scm` is an INDEPENDENT statement of the same question, written and
// maintained by each grammar's own authors (these are the patterns GitHub uses
// for code navigation). It is not a replacement — the real files are far thinner
// than our specs (Python's is 11 lines, with no methods, no parents and no
// visibility), so switching to them would lose most of what the index knows.
// What they are good for is a CHECK: a definition a tags query captures and the
// walk did not emit is a measured recall gap, not an opinion.
//
// `auditTags` is what the quality report calls to produce that list. Nothing in
// the indexing path uses this module, so a missing or unparsable query file
// costs nothing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Query } from "web-tree-sitter";
import type { Language } from "web-tree-sitter";
import { grammarKeyForExt, languageFor, resolveGrammarsTier, parserFor } from "./loader.js";
import type { TSNode } from "./node.js";
import { byStr } from "../sort.js";

/** One definition a tags query captured. */
export interface TagDefinition {
  /** The `@definition.<kind>` suffix — function, class, method, module, … */
  kind: string;
  name: string;
  line: number; // 1-based
}

// Compiled queries are cached: a query compiles once per grammar per process,
// and the audit runs it over every file of that language.
const queries = new Map<string, Query | null>();

function queryFor(key: string, language: Language): Query | null {
  const cached = queries.get(key);
  if (cached !== undefined) return cached;
  let compiled: Query | null = null;
  for (const dir of resolveGrammarsTier().dirs) {
    const path = join(dir, `${key}.tags.scm`);
    if (!existsSync(path)) continue;
    try {
      compiled = new Query(language, readFileSync(path, "utf8"));
    } catch {
      // A query the installed grammar version rejects is a no-op, not a failure:
      // the audit reports nothing for that language rather than breaking.
      compiled = null;
    }
    break;
  }
  queries.set(key, compiled);
  return compiled;
}

/** Whether a vendored query exists for a grammar, and whether it compiled. */
export interface TagsQueryStatus {
  /** A `<key>.tags.scm` was found next to the grammar. */
  present: boolean;
  /** It compiled against the loaded grammar. False means the two are out of step. */
  compiled: boolean;
}

/**
 * Report a grammar's query status. `extractTags` degrades to `[]` for a query
 * that does not compile, which is right at runtime but makes a broken query
 * indistinguishable from one that simply matched nothing — so the audit and its
 * tests can check the difference here instead of guessing from an empty result.
 */
export function tagsQueryStatus(key: string): TagsQueryStatus {
  const present = resolveGrammarsTier().dirs.some((d) => existsSync(join(d, `${key}.tags.scm`)));
  if (!present) return { present: false, compiled: false };
  const language = languageFor(key);
  if (!language) return { present: true, compiled: false };
  return { present: true, compiled: queryFor(key, language) !== null };
}

/**
 * Definitions the grammar's own `tags.scm` finds in this source, deduped and
 * sorted. Empty when the grammar publishes no query, when it fails to compile,
 * or when no grammar is loaded for the extension.
 */
export function extractTags(ext: string, content: string): TagDefinition[] {
  const key = grammarKeyForExt(ext);
  if (!key) return [];
  const language = languageFor(key);
  const parser = parserFor(key);
  if (!language || !parser) return [];
  const query = queryFor(key, language);
  if (!query) return [];

  let tree: { rootNode: TSNode; delete(): void } | null = null;
  try {
    tree = parser.parse(content) as unknown as { rootNode: TSNode; delete(): void };
    if (!tree) return [];
    const out: TagDefinition[] = [];
    const seen = new Set<string>();
    // A tags pattern pairs a `@name` capture with a `@definition.<kind>` capture
    // on the enclosing node, so a MATCH (not a flat capture list) is what ties
    // the two together.
    for (const match of query.matches(tree.rootNode as never)) {
      let name: string | undefined;
      let kind: string | undefined;
      let line = 0;
      for (const capture of match.captures) {
        if (capture.name === "name") {
          name = capture.node.text;
          line = capture.node.startPosition.row + 1;
        } else if (capture.name.startsWith("definition.")) {
          kind = capture.name.slice("definition.".length);
        }
      }
      if (!name || !kind) continue;
      const dedup = `${kind} ${name} ${line}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      out.push({ kind, name, line });
    }
    return out.sort((a, b) => a.line - b.line || byStr(a.name, b.name) || byStr(a.kind, b.kind));
  } catch {
    return [];
  } finally {
    tree?.delete();
  }
}
