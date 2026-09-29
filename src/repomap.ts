// Token-budgeted repo map (Aider-lineage, but deterministic and served from
// the persisted index): the most central production files with their key
// declarations, rendered to fit a token budget — the densest possible "what is
// this codebase" context an agent can load in one read. Unlike Aider's map it
// never varies with conversation state: same repo → same bytes.
import type { CodeSymbol, Graph } from "./types.js";
import type { RepoScan } from "./scan.js";
import { pagerankOf } from "./centrality.js";
import { byStr } from "./sort.js";

export interface RepoMapOptions {
  // Approximate token budget (chars/4 heuristic — deterministic, tokenizer-
  // free). Default 1024 tokens, Aider's default map size.
  budgetTokens?: number;
  maxSymbolsPerFile?: number; // default 8
  // Leave out the `# repo map` title line, for a caller embedding the map
  // under a heading of its own.
  bare?: boolean;
}

const CHARS_PER_TOKEN = 4;

// Kinds that carry no declaration worth budget: re-exports only point
// elsewhere, and a Go `package` clause repeats the directory name.
const SKIP_KINDS = new Set(["reexport", "reexport-all", "package"]);
// What a reader needs first: the types a file defines, then what it lets you
// call (its functions, then its types' methods), then its values. A map that
// spent gin.go's eight slots on a struct's fields, or flask/app.py's on
// TypeVars, showed neither Engine nor Flask.
const TYPE_KINDS = new Set([
  "class", "struct", "interface", "type", "enum", "trait", "record", "protocol", "typedef", "union", "object", "module",
]);
const CALLABLE_KINDS = new Set(["function", "def", "fn", "func", "method", "constructor", "macro"]);

function tierOf(s: CodeSymbol): number {
  const member = s.parent !== undefined;
  if (TYPE_KINDS.has(s.kind) || CALLABLE_KINDS.has(s.kind)) return member ? 2 : TYPE_KINDS.has(s.kind) ? 0 : 1;
  return member ? 4 : 3;
}

// The most salient `max` of a file's symbols. Public API first — exported, not
// `_private` or a dunder (Python marks those exported like any other method),
// and not a member of a type that is itself internal (Go's `func (w
// *responseWriter) Unwrap()`, the methods of flask's `_AppCtxGlobals`) — then
// by tier, then declaration order.
function mostSalient(symbols: CodeSymbol[], max: number): CodeSymbol[] {
  const topLevel = new Map<string, CodeSymbol>();
  for (const s of symbols) if (s.parent === undefined && !topLevel.has(s.name)) topLevel.set(s.name, s);
  const ownPublic = (s: CodeSymbol): boolean => s.exported && !s.name.startsWith("_");
  const isPublic = (s: CodeSymbol): boolean => {
    const owner = s.parent === undefined ? undefined : topLevel.get(s.parent);
    return ownPublic(s) && (owner === undefined || ownPublic(owner));
  };
  return symbols
    .map((s) => ({ s, pub: isPublic(s), tier: tierOf(s) }))
    .sort((a, b) => Number(b.pub) - Number(a.pub) || a.tier - b.tier || a.s.line - b.s.line || byStr(a.s.name, b.s.name))
    .slice(0, max)
    .map((x) => x.s);
}

// File centrality as production code sees it. The stored PageRank counts every
// edge, so a test harness that thousands of generated tests import
// (typescript-go's fourslash.go, testutil.go) outranked the compiler. Edges
// leaving test files are dropped and the rank recomputed; with none to drop,
// the stored rank is already that answer.
function productionRank(graph: Graph): Map<string, number> {
  const tests = new Set(graph.files.filter((f) => f.testFile).map((f) => f.rel));
  const edges = graph.fileEdges.filter((e) => !tests.has(e.from));
  if (edges.length === graph.fileEdges.length) return new Map(graph.files.map((f) => [f.rel, f.pagerank ?? 0]));
  const pr = pagerankOf(graph.files.map((f) => f.id), edges);
  return new Map(graph.files.map((f) => [f.rel, pr.get(f.id) ?? 0]));
}

export function renderRepoMap(scan: RepoScan, graph: Graph, opts: RepoMapOptions = {}): string {
  const budgetChars = (opts.budgetTokens ?? 1024) * CHARS_PER_TOKEN;
  const maxSymbols = opts.maxSymbolsPerFile ?? 8;

  // Tests are not what a codebase IS, and they are indexed code with symbols,
  // so they used to take slots (gin's binding/validate_test.go, eight struct
  // fields). Rank: production PageRank, then symbol count, then path — all
  // deterministic tie-breaks.
  const rank = productionRank(graph);
  const ranked = graph.files
    .filter((f) => f.fileKind === "code" && !f.testFile)
    .sort((a, b) => rank.get(b.rel)! - rank.get(a.rel)! || b.symbols - a.symbols || byStr(a.rel, b.rel));
  const records = new Map(scan.files.map((f) => [f.rel, f]));

  let out = opts.bare ? "" : `# repo map — ${graph.fileCount} files\n`;
  let files = 0;
  for (const node of ranked) {
    const rec = records.get(node.rel);
    if (!rec) continue;
    // `_` is Go's blank identifier (`var _ Iface = (*impl)(nil)`), not a name.
    const candidates = rec.symbols.filter((s) => !SKIP_KINDS.has(s.kind) && s.name !== "_");
    // The most salient, shown in declaration order so the block reads like
    // the file; what did not fit is counted rather than silently dropped.
    const shown = mostSalient(candidates, maxSymbols).sort((a, b) => a.line - b.line || byStr(a.name, b.name));
    let block = `\n${node.rel}:\n`;
    for (const s of shown) {
      const sig = (s.signature ?? `${s.kind} ${s.name}`).replace(/\s+/g, " ").trim().slice(0, 120);
      block += `  ${s.line}: ${sig}\n`;
    }
    if (candidates.length > shown.length) block += `  … ${candidates.length - shown.length} more\n`;
    if (out.length + block.length > budgetChars) break;
    out += block;
    files++;
  }
  return `${out}\n(${files} of ${ranked.length} code files shown, ~${Math.ceil(out.length / CHARS_PER_TOKEN)} tokens)\n`;
}
