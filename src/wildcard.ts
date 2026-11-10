import { escapeRegExp } from "./util.js";

// Matching for glob-derived patterns (src/glob.ts, src/ignore.ts, the
// workspace globs of src/workspaces.ts) that cannot be made to backtrack.
//
// Each of those compiles a pattern to a RegExp, and a backtracking engine tries
// every way of splitting the subject between a pattern's wildcards: `a*a*a*…b`
// against `aaaa…` costs O(length ^ wildcards). Twelve stars took 28 s for ONE
// 40-character path, and the patterns come from places nobody reviews — a
// cloned repository's .gitignore, a package.json `workspaces` list, an MCP
// client's `include`/`exclude`.
//
// A pattern is therefore kept as TOKENS. A pattern with few wildcards still
// compiles to the same RegExp as before (bounded cost, and the fastest path for
// the shapes people write: `*.log`, `src/**/*.ts`). Past that bound the tokens
// run as an NFA simulation instead: every pattern position that could be
// current is tracked at once, so the cost is pattern × subject whatever the
// pattern is. Both paths give the same verdict — tests/wildcard.test.ts checks
// one against the other.
export type WildToken =
  | { kind: "lit"; ch: string } // one literal UTF-16 code unit
  | { kind: "one" } // `?` — `[^/]`
  | { kind: "star" } // `*` — `[^/]*`
  | { kind: "any" } // `**` — `.*`
  | { kind: "prefix" } // a glob's `**/` — `(?:.*/)?`
  | { kind: "segments" } // a gitignore `**/` — `(?:[^/]+/)*`
  | { kind: "class"; source: string }; // one character, as a regex atom

// The most unbounded wildcards a pattern may hold and still run as a RegExp:
// its worst case is then quadratic in the subject, never worse.
const MAX_REGEX_WILDCARDS = 2;

const UNBOUNDED = new Set<WildToken["kind"]>(["star", "any", "prefix", "segments"]);

/** The regex source the tokens stand for (unanchored). */
export function wildcardSource(tokens: readonly WildToken[]): string {
  let re = "";
  for (const t of tokens) {
    if (t.kind === "lit") re += escapeRegExp(t.ch);
    else if (t.kind === "one") re += "[^/]";
    else if (t.kind === "star") re += "[^/]*";
    else if (t.kind === "any") re += ".*";
    else if (t.kind === "prefix") re += "(?:.*/)?";
    else if (t.kind === "segments") re += "(?:[^/]+/)*";
    else re += t.source;
  }
  return re;
}

export interface WildcardOptions {
  // Match a leading path: the pattern must be followed by the end of the
  // subject or by a `/` (`^…($|/)`), instead of spanning all of it (`^…$`).
  dirPrefix?: boolean;
}

/** The backtracking form. Exported for the equivalence tests only. */
export function wildcardRegExp(tokens: readonly WildToken[], opts: WildcardOptions = {}): RegExp {
  return new RegExp(`^${wildcardSource(tokens)}${opts.dirPrefix ? "($|/)" : "$"}`);
}

// NFA state kinds. Two tokens take two states each, because only their FIRST
// state may be left without consuming anything: `prefix` (the group is skipped
// whole, or runs to a `/`) and `segments` (the loop is left at a segment
// boundary, never from inside a segment).
const LIT = 0;
const ONE = 1;
const STAR = 2;
const ANY = 3;
const PREFIX_START = 4;
const PREFIX_INSIDE = 5;
const SEG_BOUNDARY = 6;
const SEG_INSIDE = 7;
const CLASS = 8;

// What `.` refuses without the `s` flag — the RegExp form uses `.` for `**`.
const isLineTerminator = (c: number): boolean => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

/** The non-backtracking form. Exported for the equivalence tests only. */
export function wildcardLinear(tokens: readonly WildToken[], opts: WildcardOptions = {}): (subject: string) => boolean {
  const kinds: number[] = [];
  const codes: number[] = [];
  const classes: (RegExp | undefined)[] = [];
  const push = (kind: number, code = 0, cls?: RegExp): void => {
    kinds.push(kind);
    codes.push(code);
    classes.push(cls);
  };
  for (const t of tokens) {
    if (t.kind === "lit") push(LIT, t.ch.charCodeAt(0));
    else if (t.kind === "one") push(ONE);
    else if (t.kind === "star") push(STAR);
    else if (t.kind === "any") push(ANY);
    else if (t.kind === "prefix") {
      push(PREFIX_START);
      push(PREFIX_INSIDE);
    } else if (t.kind === "segments") {
      push(SEG_BOUNDARY);
      push(SEG_INSIDE);
    } else push(CLASS, 0, new RegExp(`^(?:${t.source})$`));
  }
  const accept = kinds.length;
  const dirPrefix = opts.dirPrefix === true;

  // Follow the moves that consume nothing. They all lead to a LATER state, so
  // one ascending pass reaches every state they open.
  const close = (active: Uint8Array): void => {
    for (let s = 0; s < accept; s++) {
      if (!active[s]) continue;
      const kind = kinds[s];
      if (kind === STAR || kind === ANY) active[s + 1] = 1;
      else if (kind === PREFIX_START || kind === SEG_BOUNDARY) active[s + 2] = 1;
    }
  };

  return (subject: string): boolean => {
    let active = new Uint8Array(accept + 1);
    let next = new Uint8Array(accept + 1);
    active[0] = 1;
    close(active);
    for (let i = 0; i < subject.length; i++) {
      const c = subject.charCodeAt(i);
      const slash = c === 47;
      if (dirPrefix && slash && active[accept]) return true;
      next.fill(0);
      let alive = false;
      for (let s = 0; s < accept; s++) {
        if (!active[s]) continue;
        const kind = kinds[s];
        let to = -1;
        if (kind === LIT) {
          if (c === codes[s]) to = s + 1;
        } else if (kind === ONE) {
          if (!slash) to = s + 1;
        } else if (kind === STAR) {
          if (!slash) to = s;
        } else if (kind === ANY) {
          if (!isLineTerminator(c)) to = s;
        } else if (kind === PREFIX_START || kind === PREFIX_INSIDE) {
          // `.*/`: a `/` both stays inside `.*` and ends the group.
          const inside = kind === PREFIX_START ? s + 1 : s;
          if (!isLineTerminator(c)) to = inside;
          if (slash) {
            next[inside + 1] = 1;
            alive = true;
          }
        } else if (kind === SEG_BOUNDARY) {
          if (!slash) to = s + 1;
        } else if (kind === SEG_INSIDE) {
          to = slash ? s - 1 : s;
        } else if (classes[s]!.test(subject[i]!)) {
          to = s + 1;
        }
        if (to !== -1) {
          next[to] = 1;
          alive = true;
        }
      }
      if (!alive) return false;
      close(next);
      const swap = active;
      active = next;
      next = swap;
    }
    return active[accept] === 1;
  };
}

/**
 * A matcher for the tokens: the RegExp when its cost is bounded, the linear
 * simulation otherwise. Same verdict either way.
 */
export function wildcardMatcher(tokens: readonly WildToken[], opts: WildcardOptions = {}): (subject: string) => boolean {
  let unbounded = 0;
  for (const t of tokens) if (UNBOUNDED.has(t.kind)) unbounded++;
  if (unbounded > MAX_REGEX_WILDCARDS) return wildcardLinear(tokens, opts);
  const re = wildcardRegExp(tokens, opts);
  return (subject) => re.test(subject);
}
