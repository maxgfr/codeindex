// Unit tests for the browser shims, checked against the Node modules they
// stand in for.
//
// The byte-identical suite in browser-build.test.ts proves the shims are good
// enough for the fixtures it indexes. That is a strong end-to-end signal but a
// weak boundary one: a shim can be wrong in a way no fixture happens to
// exercise (a path with a "..", a Latin-1 byte in the 0x80–0x9F range, a file
// large enough to change the hash padding) and stay green. These tests aim at
// the boundaries directly, and the oracle is always the real node: module —
// never a hand-written expectation, which would just re-assert the shim.

import { describe, it, expect, beforeAll } from "vitest";
import { posix as nodePosix } from "node:path";
import { createHash as nodeCreateHash } from "node:crypto";
import * as shimPath from "../src/browser/path.js";
import { createHash as shimCreateHash } from "../src/browser/crypto.js";
import { Buffer as ShimBuffer } from "../src/browser/globals.js";
import * as vfs from "../src/browser/fs.js";

describe("path shim", () => {
  // Chosen for the cases import resolution actually hits: relative specifiers,
  // parent traversal, trailing slashes, dotfiles, and the escaping ".." that
  // resolve.ts explicitly relies on surviving.
  const PATHS = [
    "a/b/c",
    "a/b/../c",
    "a/b/./c",
    "./a",
    "../a",
    "../../a/b",
    "a/..",
    "a/b/",
    "/a/b/../..",
    "/a/../..",
    "/",
    "",
    ".",
    "..",
    "a//b",
    "src/index.ts",
    ".gitignore",
    "a.b.c",
    "a.",
    "noext",
    "/abs/path/file.tsx",
    "deep/../../escape",
  ];

  it("normalizes exactly as node:path.posix does", () => {
    for (const p of PATHS) {
      expect(shimPath.normalize(p), `normalize(${JSON.stringify(p)})`).toBe(nodePosix.normalize(p));
    }
  });

  it("preserves a '..' that escapes the root, which import resolution depends on", () => {
    // resolve.ts:123 documents this: a specifier escaping the tree must stay
    // escaped, or an out-of-tree import silently resolves to an in-tree file.
    expect(shimPath.normalize("../outside/mod.ts")).toBe("../outside/mod.ts");
    expect(shimPath.normalize("a/../../outside")).toBe("../outside");
  });

  it("matches node:path.posix for dirname, basename and extname", () => {
    for (const p of PATHS) {
      expect(shimPath.dirname(p), `dirname(${JSON.stringify(p)})`).toBe(nodePosix.dirname(p));
      expect(shimPath.basename(p), `basename(${JSON.stringify(p)})`).toBe(nodePosix.basename(p));
      expect(shimPath.extname(p), `extname(${JSON.stringify(p)})`).toBe(nodePosix.extname(p));
    }
  });

  it("matches node:path.posix for join and relative", () => {
    for (const a of PATHS) {
      for (const b of PATHS) {
        expect(shimPath.join(a, b), `join(${JSON.stringify(a)}, ${JSON.stringify(b)})`).toBe(nodePosix.join(a, b));
      }
    }
    const abs = PATHS.filter((p) => p.startsWith("/"));
    for (const a of abs) {
      for (const b of abs) {
        expect(shimPath.relative(a, b), `relative(${a}, ${b})`).toBe(nodePosix.relative(a, b));
      }
    }
  });
});

describe("crypto shim", () => {
  const INPUTS = [
    "",
    "a",
    "hello world",
    // Straddles the 64-byte block boundary and the 55/56-byte padding edge,
    // where a hand-rolled Merkle-Damgård padding goes wrong if it goes wrong.
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(63),
    "x".repeat(64),
    "x".repeat(65),
    "x".repeat(1000),
    "unicode: é 日本語 🎉",
  ];

  it("produces the same sha1 as node:crypto", () => {
    for (const input of INPUTS) {
      expect(shimCreateHash("sha1").update(input).digest("hex"), `sha1(${input.slice(0, 20)}…)`).toBe(
        nodeCreateHash("sha1").update(input).digest("hex"),
      );
    }
  });

  it("produces the same sha256 as node:crypto", () => {
    for (const input of INPUTS) {
      expect(shimCreateHash("sha256").update(input).digest("hex")).toBe(nodeCreateHash("sha256").update(input).digest("hex"));
    }
  });

  it("hashes raw bytes identically to strings, as sha1() promises", () => {
    // hash.ts:sha1 accepts `string | Uint8Array` and documents that a string is
    // hashed as its UTF-8 bytes — "identical to hashing the bytes
    // writeFileSync would put on disk for that string".
    // Built from char codes rather than written literally: sources.test.ts
    // forbids a raw NUL anywhere in the tree, and a raw high byte would make the
    // assertion depend on this file's own encoding rather than on the shim.
    const text = "binary-ish " + String.fromCharCode(0xff, 0x00) + " payload";
    const bytes = new TextEncoder().encode(text);
    expect(shimCreateHash("sha1").update(bytes).digest("hex")).toBe(shimCreateHash("sha1").update(text).digest("hex"));
    expect(shimCreateHash("sha1").update(bytes).digest("hex")).toBe(nodeCreateHash("sha1").update(bytes).digest("hex"));
  });

  it("accumulates across update() calls like node:crypto", () => {
    expect(shimCreateHash("sha1").update("foo").update("bar").digest("hex")).toBe(nodeCreateHash("sha1").update("foobar").digest("hex"));
  });
});

describe("Buffer shim", () => {
  // These four cases are readText's four decode paths (walk.ts:227-253). Each
  // one is a file that would be silently mis-indexed if the shim got it wrong.
  const decode = (bytes: Uint8Array) => ShimBuffer.from(bytes);

  it("round-trips UTF-8 like node:Buffer", () => {
    const text = "const x = 1; // héllo 日本語";
    expect(decode(new TextEncoder().encode(text)).toString("utf8")).toBe(text);
  });

  it("decodes latin1 as ISO-8859-1, not windows-1252", () => {
    // The trap: TextDecoder's "latin1" label means windows-1252, which remaps
    // 0x80-0x9F to typographic characters. Node's latin1 is a 1:1 byte→code
    // point map. Getting this wrong changes symbol names and content hashes for
    // any non-UTF-8 source file.
    const bytes = new Uint8Array([0x80, 0x91, 0x9f, 0xe9, 0xff]);
    expect(decode(bytes).toString("latin1")).toBe(Buffer.from(bytes).toString("latin1"));
    expect(decode(bytes).toString("latin1")).toBe("éÿ");
  });

  it("swaps 16-bit words in place for the UTF-16BE path", () => {
    const bytes = new Uint8Array([0x00, 0x41, 0x00, 0x42]);
    const shim = decode(bytes);
    const node = Buffer.from(bytes);
    shim.swap16();
    node.swap16();
    expect([...shim]).toEqual([...node]);
    expect(shim.toString("utf16le")).toBe(node.toString("utf16le"));
  });

  it("throws on swap16 of an odd length, like node:Buffer", () => {
    expect(() => decode(new Uint8Array([1, 2, 3])).swap16()).toThrow(RangeError);
  });

  it("returns a Buffer from subarray so readText can chain toString", () => {
    // readText does buf.subarray(3).toString("utf8") to strip a UTF-8 BOM. If
    // subarray returned a plain Uint8Array, that chain would throw.
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62]);
    expect(decode(bytes).subarray(3).toString("utf8")).toBe("ab");
  });

  it("agrees with node:Buffer on byteLength and concat", () => {
    expect(ShimBuffer.byteLength("héllo")).toBe(Buffer.byteLength("héllo"));
    const parts = [new Uint8Array([1, 2]), new Uint8Array([3])];
    expect([...ShimBuffer.concat(parts)]).toEqual([...Buffer.concat(parts)]);
  });
});

describe("readText decode paths through the VFS", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;

  beforeAll(async () => {
    browser = await import(/* @vite-ignore */ new URL("../scripts/engine.browser.mjs", import.meta.url).href);
  });

  const cases: [string, Uint8Array, string][] = [
    ["utf-8 BOM is stripped", new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), "a"],
    ["utf-16le BOM decodes", new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]), "ab"],
    ["utf-16be BOM decodes via swap16", new Uint8Array([0xfe, 0xff, 0x00, 0x61, 0x00, 0x62]), "ab"],
    ["a NUL byte marks the file binary", new Uint8Array([0x61, 0x00, 0x62]), ""],
    ["invalid utf-8 falls back to latin1", new Uint8Array([0x61, 0xe9, 0x62]), "aéb"],
  ];

  for (const [name, bytes, expected] of cases) {
    it(name, () => {
      browser.resetVfs();
      browser.mountFiles([{ path: "/repo/f.txt", size: bytes.byteLength, bytes }]);
      expect(browser.readText("/repo/f.txt")).toBe(expected);
    });
  }

  it("reads a file with no mounted bytes as empty, never as a phantom", () => {
    // Phase A mounts sizes without contents. A file read in that state must
    // behave as unreadable, not as a zero-byte file that gets indexed.
    browser.resetVfs();
    browser.mountFiles([{ path: "/repo/pending.ts", size: 100 }]);
    expect(browser.readText("/repo/pending.ts")).toBe("");
    expect(browser.hasFileBytes("/repo/pending.ts")).toBe(false);
  });
});

describe("VFS", () => {
  it("reports directory entries the way walk expects", () => {
    vfs.resetVfs();
    vfs.mountFiles([
      { path: "/r/a.ts", size: 1, bytes: new Uint8Array([65]) },
      { path: "/r/sub/b.ts", size: 1, bytes: new Uint8Array([66]) },
    ]);
    const dirents = vfs.readdirSync("/r", { withFileTypes: true });
    expect(dirents.map((d) => [d.name, d.isDirectory(), d.isFile(), d.isSymbolicLink()]).sort()).toEqual([
      ["a.ts", false, true, false],
      ["sub", true, false, false],
    ]);
    expect(vfs.statSync("/r/a.ts").size).toBe(1);
    expect(vfs.realpathSync("/r/sub")).toBe("/r/sub");
  });

  it("throws ENOENT for missing paths, so walk's guards fire", () => {
    vfs.resetVfs();
    expect(() => vfs.realpathSync("/nope")).toThrow(/ENOENT/);
    expect(() => vfs.statSync("/nope")).toThrow(/ENOENT/);
    expect(vfs.existsSync("/nope")).toBe(false);
  });

  it("is emptied by resetVfs so one repo cannot leak into the next", () => {
    vfs.resetVfs();
    vfs.mountFiles([{ path: "/r/a.ts", size: 1, bytes: new Uint8Array([65]) }]);
    expect(vfs.residentBytes()).toBe(1);
    vfs.resetVfs();
    expect(vfs.residentBytes()).toBe(0);
    expect(vfs.existsSync("/r/a.ts")).toBe(false);
  });
});
