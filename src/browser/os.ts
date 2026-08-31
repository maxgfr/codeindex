// `node:os` for the browser build. Two call sites, both incidental:
// ast/loader.ts uses homedir() to compute the shared grammars cache path (a
// path the browser never resolves to, because CODEINDEX_GRAMMAR_DIR wins first
// in resolveGrammarsTier), and pool.ts uses availableParallelism() inside a
// try/catch it already handles failing.

// Declared locally rather than by widening the project's `lib` to include DOM:
// this is the only DOM global the shims need, and the engine's own strictness
// should not change to accommodate one property read.
declare const navigator: { hardwareConcurrency?: number } | undefined;

export function homedir(): string {
  return "/home";
}

export function tmpdir(): string {
  return "/tmp";
}

export function availableParallelism(): number {
  return typeof navigator !== "undefined" && navigator?.hardwareConcurrency ? navigator.hardwareConcurrency : 1;
}

export function cpus(): Array<{
  model: string;
  speed: number;
  times: { user: number; nice: number; sys: number; idle: number; irq: number };
}> {
  return Array.from({ length: availableParallelism() }, () => ({
    model: "browser",
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }));
}

export function platform(): string {
  return "browser";
}

export const EOL = "\n";

export default { homedir, tmpdir, availableParallelism, cpus, platform, EOL };
