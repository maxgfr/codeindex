import type { CodeSymbol } from "../types.js";
import { maskBraced } from "../extract/imports.js";
import { stripCommentMarkers, summarizeDocLines } from "../extract/doc-text.js";

// Prisma schema files (`schema.prisma`, or a `prisma/schema/` folder of them).
// No grammar: the format is line-oriented, so a small deterministic scanner
// over the masked text reads it exactly.
//
// What it reports, in the kind vocabulary the other languages use:
//   model X { … }  → "struct"      a record of typed fields with no behaviour,
//   view X { … }   → "struct"      the same shape, read-only;
//   type X { … }   → "struct"      a composite (embedded) type, again fields only;
//   enum X { … }   → "enum";
//   a field        → "field"       (as Go, Rust, Java and C report struct fields),
//   an enum value  → "enum-member" (as every grammar reports enum members).
// "struct" rather than "class": a Prisma block declares data, never code, so
// it is no dead-code candidate and no call target the binder may prefer over
// a function. The signature keeps the keyword (`model Order`, `view Sales`),
// which is how a reader tells a model from a composite type.
//
// `datasource` and `generator` blocks are configuration and declare nothing.
// Every block is exported: Prisma has no visibility, and every one of them
// reaches the generated client. `//` comments, `/* … */` blocks and string
// bodies are masked before anything is matched, so a commented-out
// `// model Ghost { … }` is not a declaration; `///` comments directly above a
// block or a field are its doc, as Prisma itself reads them.
//
// References: a field whose type is not a Prisma scalar (`user User`,
// `items OrderItem[]`, `status OrderStatus?`) names another block. Each one is
// reported as a call site of that name on the field's line (`prismaRefs`), the
// engine's line-precise reference channel: the caller index binds it to the
// declaration (same file first, then by name across the schema's other files),
// so `refs Order` lists every field typed by Order, and the symbol graph links
// the field to the block it names.

// The scalar field types (and `Unsupported("…")`, a native type Prisma cannot
// map): a field of one of them references nothing.
const SCALARS = new Set(["String", "Boolean", "Int", "BigInt", "Float", "Decimal", "DateTime", "Json", "Bytes", "Unsupported"]);

const KINDS: Record<string, "struct" | "enum"> = { model: "struct", view: "struct", type: "struct", enum: "enum" };

const NAME = String.raw`[A-Za-z_][A-Za-z0-9_]*`;
// A block header at the top level: `model Order {`, `enum Role{`, or a header
// whose `{` sits alone on a later line. `type Alias = String` (the old type
// alias syntax) has no body and is not a block.
const HEADER = new RegExp(String.raw`^\s*(?<keyword>[A-Za-z]+)\s+(?<name>${NAME})\s*(?<open>\{)?`);
// A field: its name, its type, then `[]` (a list) and/or `?` (optional).
const FIELD = new RegExp(String.raw`^(?<name>${NAME})\s+(?<type>${NAME})(?:\s*\[\s*\])?\s*\??`);
const ENUM_VALUE = new RegExp(String.raw`^(?<name>${NAME})(?![\w(])`);

const SIGNATURE_CAP = 200;

interface Member {
  name: string;
  kind: "field" | "enum-member";
  line: number; // 1-based
  signature: string;
  type?: string; // a field's type, as written, without `[]` and `?`
  doc?: string;
}

interface Block {
  keyword: string;
  name: string;
  line: number; // 1-based
  endLine?: number; // 1-based line of the closing brace; absent when it never closes
  doc?: string;
  members: Member[];
}

// The `///` run directly above line `at` (0-based), reduced to one sentence.
// A blank line, a `//` comment or code ends it.
function docAbove(raw: string[], code: string[], at: number): string | undefined {
  const run: string[] = [];
  for (let k = at - 1; k >= 0; k--) {
    if (code[k]!.trim() !== "" || !raw[k]!.trimStart().startsWith("///")) break;
    run.push(raw[k]!);
  }
  return run.length ? summarizeDocLines(run.reverse().map(stripCommentMarkers)) : undefined;
}

// Every block of a schema, with its members. Pure and deterministic: the same
// text always yields the same blocks, in source order.
function parseBlocks(content: string): Block[] {
  const raw = content.split(/\r?\n/);
  // `"` strings only (Prisma has no other), `//` and `/* … */` comments.
  const code = maskBraced(content, { squote: "none" }).split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < code.length) {
    const header = HEADER.exec(code[i]!);
    if (!header) {
      i++;
      continue;
    }
    // Where the body opens: on the header's line, or alone on the next
    // non-blank line.
    let openLine = i;
    let openAt = header.groups!.open ? header.index + header[0].length : -1;
    if (openAt === -1) {
      if (code[i]!.slice(header.index + header[0].length).trim() !== "") {
        i++;
        continue;
      }
      let k = i + 1;
      while (k < code.length && code[k]!.trim() === "") k++;
      const lead = k < code.length ? /^\s*\{/.exec(code[k]!) : null;
      if (!lead) {
        i++;
        continue;
      }
      openLine = k;
      openAt = lead[0].length;
    }
    const keyword = header.groups!.keyword!;
    const kind = KINDS[keyword];
    const block: Block = { keyword, name: header.groups!.name!, line: i + 1, members: [] };
    // Walk the body to its matching brace. Each line's text up to the closing
    // brace is one member at most: Prisma puts one field per line.
    let depth = 1;
    let line = openLine;
    let from = openAt;
    for (; line < code.length && depth > 0; line++, from = 0) {
      const text = code[line]!;
      let to = text.length;
      for (let c = from; c < text.length; c++) {
        const ch = text.charCodeAt(c);
        if (ch === 123) depth++;
        else if (ch === 125 && --depth === 0) {
          to = c;
          break;
        }
      }
      if (kind) {
        const member = readMember(raw[line]!, text, from, to, line, kind);
        if (member) {
          if (line !== openLine) {
            const doc = docAbove(raw, code, line);
            if (doc) member.doc = doc;
          }
          block.members.push(member);
        }
      }
      if (depth === 0) break;
    }
    if (depth === 0) block.endLine = line + 1;
    if (kind) {
      const doc = docAbove(raw, code, i);
      if (doc) block.doc = doc;
      blocks.push(block);
    }
    // A block that never closes swallows the rest of the file, as it does for
    // Prisma's own parser.
    i = depth === 0 ? line + 1 : code.length;
  }
  return blocks;
}

// The member declared by `text.slice(from, to)` (masked) on line `line`
// (0-based), if any. Block attributes (`@@id`, `@@schema("auth")`) are not.
function readMember(raw: string, text: string, from: number, to: number, line: number, kind: "struct" | "enum"): Member | undefined {
  const segment = text.slice(from, to);
  const start = from + (segment.length - segment.trimStart().length);
  const body = segment.trim();
  if (!body || body.startsWith("@")) return undefined;
  // Quote the real text (strings unmasked), cut where the masked code ends,
  // so a trailing comment is not part of it.
  const signature = raw.slice(start, start + body.length).slice(0, SIGNATURE_CAP);
  if (kind === "enum") {
    const m = ENUM_VALUE.exec(body);
    return m ? { name: m.groups!.name!, kind: "enum-member", line: line + 1, signature } : undefined;
  }
  const m = FIELD.exec(body);
  return m ? { name: m.groups!.name!, kind: "field", line: line + 1, signature, type: m.groups!.type! } : undefined;
}

function toSymbols(rel: string, blocks: Block[]): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  for (const b of blocks) {
    out.push({
      name: b.name,
      kind: KINDS[b.keyword]!,
      file: rel,
      line: b.line,
      ...(b.endLine !== undefined ? { endLine: b.endLine } : {}),
      signature: `${b.keyword} ${b.name}`,
      ...(b.doc !== undefined ? { doc: b.doc } : {}),
      exported: true,
      lang: "prisma",
    });
    for (const m of b.members) {
      out.push({
        name: m.name,
        kind: m.kind,
        file: rel,
        line: m.line,
        endLine: m.line,
        parent: b.name,
        signature: m.signature,
        ...(m.doc !== undefined ? { doc: m.doc } : {}),
        exported: true,
        lang: "prisma",
      });
    }
  }
  return out;
}

// The references a schema makes: one site per field typed by a non-scalar
// (another model, view, enum or composite type), deduped by name and line, in
// source order. Read by extract/code.ts in place of the generic call scanner,
// which would report `@default(now())` as calls to `default` and `now`.
export function prismaRefs(content: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const seen = new Set<string>();
  for (const b of parseBlocks(content)) {
    for (const m of b.members) {
      if (m.type === undefined || SCALARS.has(m.type)) continue;
      const key = `${m.type} ${m.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: m.type, line: m.line });
    }
  }
  return out;
}

export const prisma = {
  lang: "prisma",
  exts: [".prisma"],
  extract(rel: string, content: string): CodeSymbol[] {
    return toSymbols(rel, parseBlocks(content));
  },
  calls: prismaRefs,
};
