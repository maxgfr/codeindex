// Token-economy metric for a single-symbol lookup: an honest byte measurement
// of a raw grep vs the structured JSON our query returns.

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
