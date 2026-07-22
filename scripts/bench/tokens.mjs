// Token-economy metrics for a single-symbol lookup. Two side-by-side methods,
// both published so the reader can see the difference between a competitor's
// self-serving formula and an honest byte measurement.

// 01x-in's published token-savings formula, reproduced VERBATIM for
// comparability with their numbers: a grep costs 30 tokens per matched line, an
// indexed lookup costs 5 tokens per symbol character plus a flat 200. Ratio > 1
// means the index is cheaper. We do not endorse these constants — we reproduce
// them so our own repos plug into the same arithmetic.
export function formula01x(symbol, grepLines) {
  const grepTokens = grepLines * 30;
  const indexTokens = symbol.length * 5 + 200;
  return { grepTokens, indexTokens, ratio: indexTokens ? grepTokens / indexTokens : 0 };
}

// Honest measurement: tokens ~= bytes / 4. (a) is the raw grep output an agent
// would paste, (b) is the structured JSON our query returns. Same divisor on
// both sides, so the ratio is the real context saving.
export function measuredTokens(grepBytes, indexBytes) {
  const grepTokens = grepBytes / 4;
  const indexTokens = indexBytes / 4;
  return { grepTokens, indexTokens, ratio: indexTokens ? grepTokens / indexTokens : 0 };
}

export function byteLen(s) {
  return Buffer.byteLength(s, "utf8");
}
