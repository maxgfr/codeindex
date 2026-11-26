import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSymbols, languageOf } from "../src/lang/registry.js";
import { extractCode } from "../src/extract/code.js";
import { classify } from "../src/classify.js";
import { scanRepo, type RepoScan } from "../src/scan.js";
import { findReferences, findSymbol, resolveSymbolRef } from "../src/query.js";
import { searchIndex } from "../src/bm25.js";
import { buildSymbolGraph } from "../src/symbolgraph.js";
import { importPairsFor } from "../src/derived.js";

// Prisma schemas (issue #55): no grammar, a line scanner over masked text.
// The fixture is synthetic and exercises every shape the scanner must read:
// config blocks that declare nothing, docs, comments that look like blocks,
// multi-schema attributes, and formatting no formatter would produce.
const SCHEMA = [
  "// Synthetic shop schema.", // 1
  "datasource db {",
  '  provider = "postgresql"',
  '  url      = env("DATABASE_URL") // "model Fake {"',
  '  schemas  = ["auth", "shop"]', // 5
  "}",
  "",
  "generator client {",
  '  provider        = "prisma-client-js"',
  '  previewFeatures = ["multiSchema", "views"]', // 10
  "}",
  "",
  "/// Who can sign in.",
  "enum Role {",
  "  USER", // 15
  '  ADMIN @map("admin")',
  '  @@schema("auth")',
  "}",
  "",
  "/// A customer account.", // 20
  "model User {",
  "  id      Int      @id @default(autoincrement())",
  "  email   String   @unique",
  "  /// The role granted at sign-up.",
  "  role    Role     @default(USER)", // 25
  "  orders  Order[]",
  "  address Address?",
  "",
  '  @@schema("auth")',
  "}", // 30
  "",
  "// model Ghost {",
  "//   id Int @id",
  "// }",
  "", // 35
  "/* model Phantom {",
  "  id Int @id",
  "} */",
  "",
  "enum OrderStatus{ PENDING", // 40
  "  PAID }",
  "",
  "model Order {   id Int @id @default(autoincrement())",
  "  user   User @relation(fields: [userId], references: [id], onDelete: Cascade)",
  "  userId Int", // 45
  "  items  OrderItem[]",
  "  status OrderStatus? @default(PENDING)",
  '  note   String @default("{ not a brace }")',
  "  @@index([userId])",
  '  @@schema("shop")', // 50
  "}",
  "",
  "model OrderItem",
  "{",
  "  id      Int     @id", // 55
  "  order   Order   @relation(fields: [orderId], references: [id])",
  "  orderId Int",
  "  price   Decimal @db.Decimal(10, 2)",
  '  @@schema("shop") }',
  "", // 60
  "/// A postal address, embedded in a user.",
  "type Address {",
  "  street String",
  "  geo    Geo?",
  "}", // 65
  "",
  "type Geo {",
  "  lat Float",
  "  lng Float",
  "}", // 70
  "",
  "view OrderTotal {",
  "  orderId Int     @unique",
  "  total   Decimal",
  "  order   Order   @relation(fields: [orderId], references: [id])", // 75
  "",
  '  @@schema("shop")',
  "}",
  "",
].join("\n");

const table = (src: string) =>
  extractSymbols("prisma/schema.prisma", ".prisma", src).map(
    (s) => `${s.line}-${s.endLine ?? "?"} ${s.kind} ${s.parent ? `${s.parent}/` : ""}${s.name}`,
  );

describe("Prisma: language", () => {
  it("labels .prisma files and classifies them as code", () => {
    expect(languageOf(".prisma")).toBe("prisma");
    expect(classify("prisma/schema.prisma", ".prisma")).toBe("code");
  });
});

describe("Prisma: declarations", () => {
  it("reports models, views, enums and composite types with their members, and nothing else", () => {
    expect(table(SCHEMA)).toEqual([
      "14-18 enum Role",
      "15-15 enum-member Role/USER",
      "16-16 enum-member Role/ADMIN",
      "21-30 struct User",
      "22-22 field User/id",
      "23-23 field User/email",
      "25-25 field User/role",
      "26-26 field User/orders",
      "27-27 field User/address",
      "40-41 enum OrderStatus",
      "40-40 enum-member OrderStatus/PENDING",
      "41-41 enum-member OrderStatus/PAID",
      "43-51 struct Order",
      "43-43 field Order/id",
      "44-44 field Order/user",
      "45-45 field Order/userId",
      "46-46 field Order/items",
      "47-47 field Order/status",
      "48-48 field Order/note",
      "53-59 struct OrderItem",
      "55-55 field OrderItem/id",
      "56-56 field OrderItem/order",
      "57-57 field OrderItem/orderId",
      "58-58 field OrderItem/price",
      "62-65 struct Address",
      "63-63 field Address/street",
      "64-64 field Address/geo",
      "67-70 struct Geo",
      "68-68 field Geo/lat",
      "69-69 field Geo/lng",
      "72-78 struct OrderTotal",
      "73-73 field OrderTotal/orderId",
      "74-74 field OrderTotal/total",
      "75-75 field OrderTotal/order",
    ]);
  });

  it("ignores commented-out blocks, block attributes and config blocks", () => {
    const names = extractSymbols("schema.prisma", ".prisma", SCHEMA).map((s) => s.name);
    for (const absent of ["Ghost", "Phantom", "Fake", "db", "client", "provider", "url", "schemas", "@@schema", "@@index"]) {
      expect(names, absent).not.toContain(absent);
    }
  });

  it("keeps the keyword in the signature, the field line as written, and exports everything", () => {
    const syms = extractSymbols("schema.prisma", ".prisma", SCHEMA);
    const at = (name: string, parent?: string) => syms.find((s) => s.name === name && s.parent === parent)!;
    expect(at("User")).toMatchObject({ signature: "model User", exported: true, lang: "prisma" });
    expect(at("OrderTotal").signature).toBe("view OrderTotal");
    expect(at("Address").signature).toBe("type Address");
    expect(at("Role").signature).toBe("enum Role");
    // Strings are quoted as written; a trailing comment is not part of it.
    expect(at("note", "Order").signature).toBe('note   String @default("{ not a brace }")');
    expect(at("id", "Order").signature).toBe("id Int @id @default(autoincrement())");
    expect(at("ADMIN", "Role").signature).toBe('ADMIN @map("admin")');
    expect(syms.every((s) => s.exported)).toBe(true);
  });

  it("reads `///` docs directly above a block or a field, never `//` comments", () => {
    const syms = extractSymbols("schema.prisma", ".prisma", SCHEMA);
    const doc = (name: string, parent?: string) => syms.find((s) => s.name === name && s.parent === parent)?.doc;
    expect(doc("Role")).toBe("Who can sign in.");
    expect(doc("User")).toBe("A customer account.");
    expect(doc("role", "User")).toBe("The role granted at sign-up.");
    expect(doc("Address")).toBe("A postal address, embedded in a user.");
    expect(doc("OrderStatus")).toBeUndefined();
    expect(doc("Order")).toBeUndefined();
    const plain = ["// Not a doc.", "model Plain {", "  id Int @id", "}"].join("\n");
    expect(extractSymbols("p.prisma", ".prisma", plain)[0]!.doc).toBeUndefined();
    const detached = ["/// Detached by a blank line.", "", "model Far {", "  id Int @id", "}"].join("\n");
    expect(extractSymbols("p.prisma", ".prisma", detached)[0]!.doc).toBeUndefined();
  });

  it("reads one-line blocks and blocks that never close", () => {
    expect(table("model Tiny { id Int @id }\nenum E { A }\n")).toEqual([
      "1-1 struct Tiny",
      "1-1 field Tiny/id",
      "2-2 enum E",
      "2-2 enum-member E/A",
    ]);
    expect(table("model Open {\n  id Int @id\n")).toEqual(["1-? struct Open", "2-2 field Open/id"]);
    // The old type alias syntax has no body: no block.
    expect(table("type Email = String\nmodel M {\n  id Int @id\n}\n")).toEqual(["2-4 struct M", "3-3 field M/id"]);
  });
});

describe("Prisma: references", () => {
  it("reports a field typed by another block as a reference site, scalars as nothing", () => {
    const { calls } = extractCode("prisma/schema.prisma", ".prisma", SCHEMA);
    expect(calls).toEqual([
      { name: "Address", line: 27 },
      { name: "Geo", line: 64 },
      { name: "Order", line: 26 },
      { name: "Order", line: 56 },
      { name: "Order", line: 75 },
      { name: "OrderItem", line: 46 },
      { name: "OrderStatus", line: 47 },
      { name: "Role", line: 25 },
      { name: "User", line: 44 },
    ]);
    // Attribute functions are not calls: `@default(now())` names no block.
    const names = (calls ?? []).map((c) => c.name);
    for (const absent of ["default", "autoincrement", "relation", "env", "map", "schema", "index", "Decimal", "String"]) {
      expect(names, absent).not.toContain(absent);
    }
  });
});

describe("Prisma: in a scanned repo", () => {
  const FILES: Record<string, string> = {
    "prisma/schema.prisma": SCHEMA,
    // A multi-file schema folder: a field typed by a model of another file.
    "db/schema/catalog.prisma": "/// A product for sale.\nmodel Product {\n  id    Int    @id\n  shelf Shelf?\n}\n",
    "db/schema/shelf.prisma": "model Shelf {\n  id       Int       @id\n  products Product[]\n}\n",
    // A TypeScript homonym: the schema's references must not bind to it.
    "src/order.ts": "export class Order {\n  total(): number {\n    return 0;\n  }\n}\n",
    "README.md": "# Shop\n",
  };
  let repo: string;
  let scan: RepoScan;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ci-prisma-"));
    for (const [rel, content] of Object.entries(FILES)) {
      mkdirSync(join(repo, rel, ".."), { recursive: true });
      writeFileSync(join(repo, rel), content);
    }
    scan = scanRepo(repo);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("records the schema as prisma code with its symbols", () => {
    const f = scan.files.find((x) => x.rel === "prisma/schema.prisma")!;
    expect(f).toMatchObject({ kind: "code", lang: "prisma" });
    expect(f.symbols.filter((s) => s.parent === undefined).map((s) => s.name)).toEqual([
      "Role", "User", "OrderStatus", "Order", "OrderItem", "Address", "Geo", "OrderTotal",
    ]);
  });

  it("finds a model and its fields by name and by member path", () => {
    const [order] = findSymbol(scan, "Order").filter((m) => m.file === "prisma/schema.prisma");
    expect(order).toMatchObject({ kind: "struct", line: 43, endLine: 51 });
    expect(resolveSymbolRef(scan, "Order/user")?.defs.map((d) => `${d.file}:${d.line}`)).toEqual(["prisma/schema.prisma:44"]);
  });

  it("lists every field typed by a model as its uses inside the schema", () => {
    const refs = findReferences(scan, "Order@prisma/schema.prisma");
    expect(refs.defs.map((d) => `${d.kind} ${d.file}:${d.line}`)).toEqual(["struct prisma/schema.prisma:43"]);
    expect(refs.callSites).toEqual([
      { file: "prisma/schema.prisma", line: 26 },
      { file: "prisma/schema.prisma", line: 56 },
      { file: "prisma/schema.prisma", line: 75 },
    ]);
    expect(findReferences(scan, "OrderStatus").callSites).toEqual([{ file: "prisma/schema.prisma", line: 47 }]);
    expect(findReferences(scan, "Geo").callSites).toEqual([{ file: "prisma/schema.prisma", line: 64 }]);
    expect(findReferences(scan, "User@prisma/schema.prisma").callSites).toEqual([{ file: "prisma/schema.prisma", line: 44 }]);
  });

  it("never binds a schema reference to a homonym in another language", () => {
    const ts = findReferences(scan, "Order@src/order.ts");
    expect(ts.callSites).toEqual([]);
    expect(ts.referencingFiles).not.toContain("prisma/schema.prisma");
  });

  it("binds a reference across the files of a schema folder", () => {
    expect(findReferences(scan, "Shelf").callSites).toEqual([{ file: "db/schema/catalog.prisma", line: 4 }]);
    expect(findReferences(scan, "Product").callSites).toEqual([{ file: "db/schema/shelf.prisma", line: 3 }]);
  });

  it("links the referencing field to the block it names in the symbol graph", () => {
    const graph = buildSymbolGraph(scan, importPairsFor(scan));
    expect(graph.edges).toContainEqual({
      from: "prisma/schema.prisma#Order/user",
      to: "prisma/schema.prisma#User",
      kind: "calls",
      weight: 1,
    });
  });

  it("ranks the schema first for a model name", () => {
    const [top] = searchIndex(scan, "OrderItem");
    expect(top!.file).toBe("prisma/schema.prisma");
    expect(top!.topSymbols).toContain("OrderItem");
    expect(top!.symbolHits).toContainEqual({ name: "OrderItem", kind: "struct", line: 53 });
    expect(top!.matchedFields).toContain("name");
    expect(searchIndex(scan, "shelf")[0]?.file).toBe("db/schema/shelf.prisma");
  });
});
