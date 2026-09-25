// Single-file components: Vue (.vue), Svelte (.svelte) and Astro (.astro).
//
// Their code is ordinary JS/TS sitting inside markup: `<script>` blocks, plus
// Astro's `---` frontmatter. They classify as code, but no extractor read that
// code, so a component yielded no symbols, no imports and no calls. In a Vue or
// Svelte app that is where most of the code lives: every helper a component
// called looked dead, and no edge ran from a component to anything.
//
// The fix reuses the JS/TS tier rather than a new grammar. `sfcScript` returns a
// copy of the file with everything OUTSIDE the script blocks blanked to spaces,
// newlines kept, so every offset and line of the copy is the offset and line
// in the component — a symbol found on line 12 of the copy is on line 12 of
// the .vue file. Deterministic, no dependency, no extra wasm.

export const SFC_EXTS = new Set([".vue", ".svelte", ".astro"]);

export interface SfcParts {
  /** The script code, markup blanked; parse it as a file of extension `ext`. */
  script: string;
  /** `.ts`, `.tsx`, `.jsx` or `.js` — the grammar the script blocks are written in. */
  ext: string;
  /** The markup, script and style bodies and HTML comments blanked. */
  markup: string;
  /**
   * 1-based line ranges (inclusive) whose `export` makes no module export:
   * a Svelte instance script's `export let` declares a PROP the parent sets in
   * markup, and Astro's frontmatter exports (`Props`, `getStaticPaths`) are read
   * by the framework. Nothing can import them, so the symbols declared there are
   * not exported — else every prop of every component would read as dead code.
   */
  notExported: [number, number][];
}

// An opening tag, its attributes read quote-aware: Vue's `generic="T extends
// Record<string, X>"` holds a `>` that must not end the tag. HTML comments are
// matched in the same pass so a commented-out block is skipped whole.
const BLOCK_OPEN = /<!--[\s\S]*?(?:-->|$)|<(script|style)(?=[\s>/])((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTR = (name: string): RegExp => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
const LANG_ATTR = ATTR("lang");
const TYPE_ATTR = ATTR("type");
const CONTEXT_ATTR = ATTR("context");
// Svelte 5 marks the module script with a bare `module` attribute.
const MODULE_FLAG = /(?:^|\s)module(?=[\s/=]|$)/i;
// A `type` that still means script: JSON, `text/template` and friends are data
// the JS grammar would only misread.
const SCRIPT_TYPE = /^(?:module|(?:text|application)\/(?:javascript|ecmascript|typescript|babel)|text\/jsx|)$/i;
// Astro's frontmatter: a `---` fence opening the file (`\s` also skips a BOM),
// closed by the next `---` line.
const FRONTMATTER = /^\s*---[ \t]*\r?\n/;
const FENCE_CLOSE = /^---[ \t]*\r?$/m;

function attr(attrs: string, re: RegExp): string | undefined {
  const m = re.exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim().toLowerCase() : undefined;
}

// Every code unit except line breaks becomes a space: lengths and line
// structure survive, content does not.
function blank(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

// `content` with every [from, to) range kept (keep = true) or blanked (false),
// and the rest the other way round. Ranges are sorted and disjoint.
function select(content: string, ranges: [number, number][], keep: boolean): string {
  let out = "";
  let at = 0;
  for (const [from, to] of ranges) {
    const gap = content.slice(at, from);
    const span = content.slice(from, to);
    out += keep ? blank(gap) + span : gap + blank(span);
    at = to;
  }
  const tail = content.slice(at);
  return out + (keep ? blank(tail) : tail);
}

// The 1-based line ranges of sorted, disjoint offset ranges, in one pass.
function lineRanges(content: string, ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let line = 1;
  let at = 0;
  const advance = (to: number): void => {
    for (let i = content.indexOf("\n", at); i !== -1 && i < to; i = content.indexOf("\n", i + 1)) line++;
    at = to;
  };
  for (const [from, to] of ranges) {
    advance(from);
    const first = line;
    advance(to);
    out.push([first, line]);
  }
  return out;
}

export function sfcParts(ext: string, content: string): SfcParts | undefined {
  if (!SFC_EXTS.has(ext)) return undefined;
  const code: [number, number][] = [];
  const hidden: [number, number][] = []; // script and style bodies, comments
  const local: [number, number][] = []; // code whose exports are not module exports
  let ts = false;
  let jsx = false;
  let from = 0;
  if (ext === ".astro") {
    // The frontmatter is TypeScript by definition, so the whole file parses as
    // TS; Astro's `<script>` tags are bundled TS too.
    ts = true;
    const open = FRONTMATTER.exec(content);
    if (open) {
      const start = open[0].length;
      const close = FENCE_CLOSE.exec(content.slice(start));
      const end = close ? start + close.index : content.length;
      code.push([start, end]);
      hidden.push([start, end]);
      local.push([start, end]);
      from = close ? end + close[0].length : end;
    }
  }
  BLOCK_OPEN.lastIndex = from;
  for (let m: RegExpExecArray | null; (m = BLOCK_OPEN.exec(content)); ) {
    const tag = m[1]?.toLowerCase();
    if (!tag) {
      hidden.push([m.index, m.index + m[0].length]);
      continue;
    }
    const attrs = m[2]!;
    const start = m.index + m[0].length;
    if (attrs.trimEnd().endsWith("/")) continue; // `<script src="x.js" />`: no body
    const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
    closeRe.lastIndex = start;
    const close = closeRe.exec(content);
    const end = close ? close.index : content.length;
    BLOCK_OPEN.lastIndex = close ? close.index + close[0].length : content.length;
    hidden.push([start, end]);
    if (tag !== "script") continue;
    const type = attr(attrs, TYPE_ATTR);
    if (type !== undefined && !SCRIPT_TYPE.test(type)) continue;
    const lang = attr(attrs, LANG_ATTR) ?? "js";
    if (lang === "ts" || lang === "typescript") ts = true;
    else if (lang === "tsx") ts = jsx = true;
    else if (lang === "jsx") jsx = true;
    else if (lang !== "js" && lang !== "javascript") continue; // CoffeeScript and the like
    code.push([start, end]);
    // Only Vue script blocks and a Svelte MODULE script export for real; an
    // Astro `<script>` is a client bundle whose exports reach nothing.
    const moduleScript = attr(attrs, CONTEXT_ATTR) === "module" || MODULE_FLAG.test(attrs);
    if (ext === ".astro" || (ext === ".svelte" && !moduleScript)) local.push([start, end]);
  }
  return {
    script: select(content, code, true),
    // TS is a superset the JS grammar cannot read, so one TS block makes the
    // whole script TS (Vue requires both blocks of a component to agree anyway).
    ext: ts ? (jsx ? ".tsx" : ".ts") : jsx ? ".jsx" : ".js",
    markup: select(content, hidden, false),
    notExported: lineRanges(content, local),
  };
}
