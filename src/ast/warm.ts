import { allGrammarKeys, ensureGrammars, grammarReady, resolveGrammarsTier, sharedGrammarsCacheDir } from "./loader.js";
import type { GrammarsTierName } from "./loader.js";
import { pullGrammars } from "./grammars-pull.js";

// The one-call AST warm-up every consumer needs, and which every consumer but
// ultraindex was missing.
//
// WHY THIS EXISTS. Extraction is AST-preferred with a regex fallback
// (src/extract/code.ts), but `extractAst` returns undefined unless
// `grammarReady(key)` — and that is only true after an `await ensureGrammars()`.
// `scanRepo` is deliberately synchronous, so it CANNOT warm anything itself.
// A consumer that never awaits the warm-up therefore runs on the regex tier
// forever, on every machine, no matter what the grammar cache holds — silently,
// since the fallback is by design invisible. That is a capability quietly left
// on the table, not a crash, which is exactly why it survived unnoticed.
//
// So: call this ONCE at your CLI entry, before the synchronous pipeline. It is
// idempotent, offline-safe, and never throws.
export interface WarmGrammarsResult {
  /** Tier AFTER the warm-up (a successful pull moves "none" → "cache"). */
  tier: GrammarsTierName;
  /** True when at least one requested grammar is loaded ⇒ the AST tier is live. */
  ready: boolean;
  /** True when this call populated the shared cache over the network. */
  pulled: boolean;
  /** Everything written to `onNote`, in order — so a caller can persist the trail in its run artifacts. */
  notes: string[];
}

export interface WarmGrammarsOptions {
  /** Grammars to load. Default: every shipped grammar. Narrow it with `grammarKeysForExts` when the repo's languages are known. */
  keys?: Iterable<string>;
  /** Fetch the wasms into the shared cache when nothing is resolvable. Default true; `CODEINDEX_NO_GRAMMARS_PULL=1` forces false. */
  pull?: boolean;
  /** Prefix for the diagnostics ("ultrasec: …"). Default "codeindex". */
  label?: string;
  /** Where diagnostics go. Default: process.stderr. Pass a sink to keep stdout/stderr clean. */
  onNote?: (msg: string) => void;
}

export async function warmGrammars(opts: WarmGrammarsOptions = {}): Promise<WarmGrammarsResult> {
  const label = opts.label ?? "codeindex";
  const notes: string[] = [];
  const note = (msg: string): void => {
    notes.push(msg);
    if (opts.onNote) opts.onNote(msg);
    else process.stderr.write(msg);
  };
  const noPull = process.env.CODEINDEX_NO_GRAMMARS_PULL;
  const mayPull = (opts.pull ?? true) && !(noPull && noPull.trim() && noPull !== "0");
  const keys = [...(opts.keys ?? allGrammarKeys())];

  let pulled = false;
  if (resolveGrammarsTier().tier === "none" && mayPull) {
    note(`${label}: tree-sitter grammars not found locally — pulling them into the shared cache (once per machine)…\n`);
    const res = await pullGrammars(sharedGrammarsCacheDir(), { onNote: note });
    note(res.message);
    pulled = res.ok && res.status === "pulled";
  }

  await ensureGrammars(keys);

  const tier = resolveGrammarsTier().tier;
  const ready = keys.some((k) => grammarReady(k));
  if (!ready) {
    // Never silent: a degraded run must say so, and stay a SUCCESSFUL run —
    // the regex tier still produces a complete, searchable result.
    note(
      `${label}: no tree-sitter grammars available (offline?) — extracting with the regex tier, so symbols and call sites are less precise. ` +
        "Run `codeindex grammars pull` once online to enable AST precision.\n",
    );
  }
  return { tier, ready, pulled, notes };
}
