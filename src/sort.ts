// Locale-INDEPENDENT string comparator (UTF-16 code-unit order). Used for every
// sort that feeds the on-disk artifact, so two builds on different machines /
// locales produce byte-identical output. `localeCompare` must NOT be used for
// artifact ordering — its result varies with the host's ICU locale.
export function byStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Sort by a string key, stably and locale-independently.
export function byKey<T>(keyOf: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => byStr(keyOf(a), keyOf(b));
}
