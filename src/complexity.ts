// Cyclomatic-complexity estimates from branch-token counting over symbol line
// spans (language-generic: if/for/while/case/catch families plus &&, ||, and
// ternaries), and the risk ranking nobody else in the space ships: complexity
// × git churn — files that are BOTH hard to reason about AND constantly
// changed are where defects concentrate.
import { join } from "node:path";
import type { RepoScan } from "./scan.js";
import { fileComplexityFor } from "./derived.js";
import { readText } from "./walk.js";
import { byStr } from "./sort.js";

const BRANCH_RE =
  /\b(if|elif|elsif|else\s+if|for|foreach|while|until|unless|case|when|match|catch|rescue|except)\b|&&|\|\||(?<![?:])\?(?![?.:])/g;

export function complexityOfSource(source: string): number {
  return 1 + (source.match(BRANCH_RE) ?? []).length;
}

export interface SymbolComplexity {
  file: string;
  name: string;
  line: number;
  endLine?: number;
  complexity: number;
}

// Per-symbol complexity for one file (or the whole repo when rel is omitted),
// sorted most-complex first. Symbols without an endLine (regex tier) fall back
// to a single-line estimate and naturally rank low — labeled by the absent
// endLine rather than silently guessed.
export function symbolComplexity(scan: RepoScan, rel?: string, top = 50): SymbolComplexity[] {
  const out: SymbolComplexity[] = [];
  for (const f of scan.files) {
    if (f.kind !== "code") continue;
    if (rel && f.rel !== rel) continue;
    if (!f.symbols.length) continue;
    const lines = readText(join(scan.root, f.rel)).split("\n");
    for (const s of f.symbols) {
      if (s.kind === "reexport" || s.kind === "reexport-all") continue;
      const end = s.endLine ?? s.line;
      const body = lines.slice(s.line - 1, end).join("\n");
      const entry: SymbolComplexity = { file: f.rel, name: s.name, line: s.line, complexity: complexityOfSource(body) };
      if (s.endLine !== undefined) entry.endLine = s.endLine;
      out.push(entry);
    }
  }
  out.sort((a, b) => b.complexity - a.complexity || byStr(a.file, b.file) || a.line - b.line);
  return out.slice(0, top);
}

export interface RiskHotspot {
  file: string;
  complexity: number; // whole-file branch count + 1
  commits: number;
  // (commits + 1) × complexity — churn amplifies complexity; a complex but
  // frozen file ranks below a complex file under constant change.
  score: number;
}

export function riskHotspots(scan: RepoScan, churn: Map<string, number>, top = 20): RiskHotspot[] {
  // Per-file branch counts memoized per scan (src/derived.ts): the first call
  // still reads every code file from disk, repeat calls become map lookups.
  // fileComplexityFor covers exactly the code files filtered below, so the
  // lookup always hits.
  const complexityByFile = fileComplexityFor(scan);
  const out: RiskHotspot[] = scan.files
    .filter((f) => f.kind === "code")
    .map((f) => {
      const complexity = complexityByFile.get(f.rel)!;
      const commits = churn.get(f.rel) ?? 0;
      return { file: f.rel, complexity, commits, score: (commits + 1) * complexity };
    });
  out.sort((a, b) => b.score - a.score || byStr(a.file, b.file));
  return out.slice(0, top);
}
