import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ENGINE_VERSION } from "./types.js";
import { ensureGrammars, allGrammarKeys } from "./ast/loader.js";
import { buildIndexArtifacts, type BuildIndexOptions } from "./pipeline.js";
import { renderGraphJson } from "./render/graph-json.js";
import { renderSymbolsJson } from "./render/symbols-json.js";

const HELP = `codeindex engine v${ENGINE_VERSION} — deterministic repo indexing

Usage: engine.mjs <command> [flags]

Commands:
  scan      Scan summary: file count, language histogram, capped flag
  graph     Full link-graph (graph.json bytes) to stdout or --out
  symbols   Symbol index (symbols.json bytes) to stdout or --out
  version   Print the engine version

Flags:
  --repo <dir>        Repo root (default: cwd)
  --out <file>        Write output to a file instead of stdout
  --include <glob>    Only include matching paths (repeatable)
  --exclude <glob>    Exclude matching paths (repeatable)
  --max-files <n>     Cap walked files (default 20000)
  --max-bytes <n>     Skip files above this size (default 1 MiB)
  --no-ast            Skip tree-sitter grammars even when present (regex tier)
`;

interface CliFlags {
  repo: string;
  out?: string;
  include: string[];
  exclude: string[];
  maxFiles?: number;
  maxBytes?: number;
  noAst: boolean;
}

function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = { repo: process.cwd(), include: [], exclude: [], noAst: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--repo") flags.repo = resolve(next());
    else if (a === "--out") flags.out = resolve(next());
    else if (a === "--include") flags.include.push(next());
    else if (a === "--exclude") flags.exclude.push(next());
    else if (a === "--max-files") flags.maxFiles = Number(next());
    else if (a === "--max-bytes") flags.maxBytes = Number(next());
    else if (a === "--no-ast") flags.noAst = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

function emit(content: string, out?: string): void {
  if (out) writeFileSync(out, content);
  else process.stdout.write(content);
}

function scanOptions(flags: CliFlags): BuildIndexOptions {
  return {
    include: flags.include.length ? flags.include : undefined,
    exclude: flags.exclude.length ? flags.exclude : undefined,
    maxFiles: flags.maxFiles,
    maxBytes: flags.maxBytes,
  };
}

export async function runCli(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "version" || cmd === "--version") {
    process.stdout.write(ENGINE_VERSION + "\n");
    return;
  }

  const flags = parseFlags(rest);
  if (!flags.noAst) await ensureGrammars(allGrammarKeys());

  if (cmd === "scan") {
    const { scan } = buildIndexArtifacts(flags.repo, scanOptions(flags));
    const summary = {
      engineVersion: ENGINE_VERSION,
      commit: scan.commit,
      fileCount: scan.files.length,
      languages: scan.languages,
      capped: scan.capped,
    };
    emit(JSON.stringify(summary, null, 2) + "\n", flags.out);
  } else if (cmd === "graph") {
    const { graph } = buildIndexArtifacts(flags.repo, scanOptions(flags));
    emit(renderGraphJson(graph), flags.out);
  } else if (cmd === "symbols") {
    const { symbols } = buildIndexArtifacts(flags.repo, scanOptions(flags));
    emit(renderSymbolsJson(symbols), flags.out);
  } else {
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
    process.exitCode = 2;
  }
}
