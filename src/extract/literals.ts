// Literal-value collection, shared by both extraction tiers and by the config
// walk. The AST tier and the regex tier both already visit every string literal
// in every file — they just hand it to `addTerms`, which subtokenizes into a
// Set. This module is the parallel collector that keeps the value itself.
//
// The noise is cut HERE, at capture, not in the analytic: an index that stores
// every `0` and `""` costs everyone who reads it, forever, and no downstream
// threshold can give that space back.
import type { CodeLiteral } from "../types.js";
import { byStr } from "../sort.js";

// Same ceiling the prose collector uses for "is this a value or a blob": a
// route path, an error message or a config key is worth keeping; a base64
// payload or an inlined template is not.
export const MAX_LITERAL_LEN = 80;
// A value shorter than this carries no identity — "a", "/" and "%s" recur
// everywhere and mean nothing in common.
const MIN_LITERAL_LEN = 2;
// Per-file ceiling, same doctrine as `calls`: bounded, and the bound is a
// truncation of source order (not of the sorted list, which would bias every
// large file's literals toward early values).
export const MAX_LITERALS = 256;

// Numbers whose recurrence is structural rather than semantic: loop bounds,
// array indices, sign flips, on/off. Keeping them would drown every real
// threshold — 5% alert gaps, 100-employee brackets, 4-upload caps — in noise.
const TRIVIAL_NUMBERS = new Set(["0", "1", "-1", "2", "-2"]);

// A literal made only of punctuation or whitespace ("()", " ", "-->") is
// formatting, not a value anyone centralizes.
const HAS_SUBSTANCE = /[\p{L}\p{N}]/u;

export function isInterestingString(value: string): boolean {
  if (value.length < MIN_LITERAL_LEN || value.length > MAX_LITERAL_LEN) return false;
  return HAS_SUBSTANCE.test(value);
}

export function isInterestingNumber(raw: string): boolean {
  const v = raw.trim();
  if (!v || v.length > MAX_LITERAL_LEN) return false;
  if (TRIVIAL_NUMBERS.has(v)) return false;
  return Number.isFinite(Number(v));
}

// Strips the delimiters a literal was written with, in any language the engine
// reads: quotes, backticks, and the language-specific raw/prefixed forms
// (Python r"", C# @"", Go backticks, Rust r#""#).
export function unquote(text: string): string {
  let s = text;
  const raw = /^(?:[rRbBuUfF]{1,2}|@|\$)?(?:#*)?(['"`])/.exec(s);
  if (raw) {
    const q = raw[1]!;
    const start = s.indexOf(q);
    const end = s.lastIndexOf(q);
    if (end > start) s = s.slice(start + 1, end);
  }
  return s;
}

// Accumulates literals for one file: dedups by value+line, respects the cap,
// and emits a total order so two builds of unchanged content are byte-identical.
export class LiteralCollector {
  private readonly seen = new Set<string>();
  private readonly out: CodeLiteral[] = [];

  get full(): boolean {
    return this.out.length >= MAX_LITERALS;
  }

  add(kind: CodeLiteral["kind"], value: string, line: number): void {
    if (this.full) return;
    if (kind === "string" && !isInterestingString(value)) return;
    if (kind === "number" && !isInterestingNumber(value)) return;
    if (kind === "regex" && !value) return;
    const key = `${kind}\u0000${value}\u0000${line}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.out.push({ value, line, kind });
  }

  addString(text: string, line: number): void {
    this.add("string", unquote(text), line);
  }

  result(): CodeLiteral[] | undefined {
    if (!this.out.length) return undefined;
    return this.out.sort((a, b) => byStr(a.value, b.value) || a.line - b.line || byStr(a.kind, b.kind));
  }
}

// Line number of a byte offset, 1-based. Used by the regex tiers, which scan
// text rather than walking a tree with positions on it.
export function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}
