// Token-budgeted repo map (Aider-lineage, but deterministic and served from
// the persisted index): the highest-PageRank files with their key exported
// signatures, rendered to fit a token budget — the densest possible "what is
// this codebase" context an agent can load in one read. Unlike Aider's map it
// never varies with conversation state: same repo → same bytes.
import type { Graph } from "./types.js";
import type { RepoScan } from "./scan.js";
import { byStr } from "./sort.js";

export interface RepoMapOptions {
  // Approximate token budget (chars/4 heuristic — deterministic, tokenizer-
  // free). Default 1024 tokens, Aider's default map size.
  budgetTokens?: number;
  maxSymbolsPerFile?: number; // default 8
}

const CHARS_PER_TOKEN = 4;

export function renderRepoMap(scan: RepoScan, graph: Graph, opts: RepoMapOptions = {}): string {
  const budgetChars = (opts.budgetTokens ?? 1024) * CHARS_PER_TOKEN;
  const maxSymbols = opts.maxSymbolsPerFile ?? 8;

  // Rank: PageRank first (stamped by the pipeline's centrality pass), then
  // symbol count, then path — all deterministic tie-breaks.
  const ranked = [...graph.files]
    .filter((f) => f.fileKind === "code")
    .sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0) || b.symbols - a.symbols || byStr(a.rel, b.rel));
  const records = new Map(scan.files.map((f) => [f.rel, f]));

  const header = `# repo map — ${graph.fileCount} files\n`;
  let out = header;
  let files = 0;
  for (const node of ranked) {
    const rec = records.get(node.rel);
    if (!rec) continue;
    // Exported symbols first, declaration order within each group; reference
    // kinds (re-exports) carry no signature worth budget.
    const symbols = [...rec.symbols]
      .filter((s) => s.kind !== "reexport" && s.kind !== "reexport-all")
      .sort((a, b) => Number(b.exported) - Number(a.exported) || a.line - b.line)
      .slice(0, maxSymbols);
    let block = `\n${node.rel}:\n`;
    for (const s of symbols) {
      const sig = (s.signature ?? `${s.kind} ${s.name}`).replace(/\s+/g, " ").trim().slice(0, 120);
      block += `  ${s.line}: ${sig}\n`;
    }
    if (out.length + block.length > budgetChars) break;
    out += block;
    files++;
  }
  return `${out}\n(${files} of ${ranked.length} code files shown, ~${Math.ceil(out.length / CHARS_PER_TOKEN)} tokens)\n`;
}
