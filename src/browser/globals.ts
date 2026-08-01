// Globals injected into the browser bundle (esbuild `inject`): Buffer and
// process. Both are referenced as free identifiers in the engine's source, so
// injection substitutes them without touching a single line of that source.
//
// The Buffer surface here is not "a Buffer": it is exactly what walk.ts:readText
// consumes, which is the only place in the browser build that handles raw bytes
// as text. readText has four decode paths and this must satisfy all four —
// UTF-16LE BOM, UTF-16BE BOM (via swap16), UTF-8 BOM, and the Latin-1 fallback.
//
// ONE SUBTLETY MATTERS MORE THAN THE REST. TextDecoder's "latin1" label is an
// alias for windows-1252, NOT ISO-8859-1: it remaps 0x80–0x9F to typographic
// characters instead of passing them through. Node's toString("latin1") is a
// true 1:1 byte→code-point map. Decoding through TextDecoder would therefore
// give different text for those 32 bytes — different symbol names, a different
// content hash, a different index. So latin1 is implemented by hand below, and
// only utf8/utf16le go through TextDecoder (where the WHATWG and Node
// behaviours do agree, U+FFFD replacement included — which readText depends on
// to detect that UTF-8 was the wrong guess).

const utf8Decoder = new TextDecoder("utf-8");
const utf16leDecoder = new TextDecoder("utf-16le");
const encoder = new TextEncoder();

const HEX = "0123456789abcdef";

function decodeLatin1(bytes: Uint8Array): string {
  // Chunked: String.fromCharCode.apply blows the argument limit on large files.
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return out;
}

class BrowserBuffer extends Uint8Array {
  // Params are widened to `any` for one reason: Uint8Array's static `from` is
  // the TypedArray.from overload set (arrayLike, mapfn, thisArg), and a
  // narrower `(value, encoding)` is not assignable to it, so TypeScript rejects
  // the subclass outright. The widening buys assignability; the body below is
  // exhaustive over the shapes the engine actually passes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static from(value: any, encoding?: any): BrowserBuffer {
    if (typeof value === "string") {
      if (encoding === "hex") {
        const out = new BrowserBuffer(value.length >> 1);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(value.substr(i * 2, 2), 16);
        return out;
      }
      if (encoding === "base64") {
        const binary = atob(value);
        const out = new BrowserBuffer(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
      }
      if (encoding === "latin1" || encoding === "binary") {
        const out = new BrowserBuffer(value.length);
        for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
        return out;
      }
      const encoded = encoder.encode(value);
      const out = new BrowserBuffer(encoded.length);
      out.set(encoded);
      return out;
    }
    if (value instanceof ArrayBuffer) return new BrowserBuffer(value);
    const src = value as ArrayLike<number>;
    const out = new BrowserBuffer(src.length);
    out.set(src as ArrayLike<number>);
    return out;
  }

  static alloc(size: number, fill = 0): BrowserBuffer {
    const out = new BrowserBuffer(size);
    if (fill !== 0) out.fill(fill);
    return out;
  }

  static allocUnsafe(size: number): BrowserBuffer {
    return new BrowserBuffer(size);
  }

  static isBuffer(value: unknown): boolean {
    return value instanceof BrowserBuffer;
  }

  static byteLength(value: string | Uint8Array, encoding?: string): number {
    if (typeof value !== "string") return value.byteLength;
    if (encoding === "latin1" || encoding === "binary") return value.length;
    return encoder.encode(value).length;
  }

  static concat(list: readonly Uint8Array[], totalLength?: number): BrowserBuffer {
    const total = totalLength ?? list.reduce((sum, item) => sum + item.byteLength, 0);
    const out = new BrowserBuffer(total);
    let at = 0;
    for (const item of list) {
      if (at + item.byteLength > total) {
        out.set(item.subarray(0, total - at), at);
        break;
      }
      out.set(item, at);
      at += item.byteLength;
    }
    return out;
  }

  // Overridden only to state the return type. At runtime TypedArray's species
  // constructor already produces a BrowserBuffer, but TypeScript types
  // subarray() as returning the base Uint8Array — which would make readText's
  // `buf.subarray(3).toString("utf8")` a type error, and would hide a real
  // breakage if the species behaviour ever changed.
  override subarray(begin?: number, end?: number): BrowserBuffer {
    return super.subarray(begin, end) as BrowserBuffer;
  }

  toString(encoding?: string, start?: number, end?: number): string {
    const view = start !== undefined || end !== undefined ? this.subarray(start ?? 0, end ?? this.length) : this;
    switch ((encoding ?? "utf8").toLowerCase()) {
      case "utf8":
      case "utf-8":
        return utf8Decoder.decode(view);
      case "utf16le":
      case "utf-16le":
      case "ucs2":
      case "ucs-2":
        return utf16leDecoder.decode(view);
      case "latin1":
      case "binary":
      case "ascii":
        return decodeLatin1(view);
      case "hex": {
        let out = "";
        for (const byte of view) out += HEX[byte >> 4]! + HEX[byte & 15]!;
        return out;
      }
      case "base64":
        return btoa(decodeLatin1(view));
      default:
        throw new TypeError(`Unknown encoding: ${encoding}`);
    }
  }

  // In-place 16-bit byte swap — how readText turns a UTF-16BE payload into the
  // UTF-16LE the decoder accepts. Node throws on an odd length; mirror that
  // rather than silently dropping the trailing byte.
  swap16(): this {
    if (this.length % 2 !== 0) {
      throw new RangeError("Buffer size must be a multiple of 16-bits");
    }
    for (let i = 0; i < this.length; i += 2) {
      const tmp = this[i]!;
      this[i] = this[i + 1]!;
      this[i + 1] = tmp;
    }
    return this;
  }

  equals(other: Uint8Array): boolean {
    if (this.length !== other.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  }
}

// A minimal `process`. The engine core barely touches it: loader.ts reads three
// env vars (and CODEINDEX_GRAMMAR_DIR is how the playground points the grammar
// resolver at the VFS), util.ts reads platform. `env` is a plain mutable object
// so the worker can set it before importing anything that reads it.
//
// IT MUST NOT CARRY A `versions.node`. Injection substitutes this object into
// every module in the bundle, web-tree-sitter's emscripten glue included — and
// that glue decides its environment with
// `typeof process == "object" && process.versions?.node && process.type != "renderer"`.
// Declaring a node version here would flip ENVIRONMENT_IS_NODE to true inside a
// browser and send the runtime down its require()/fs code paths. The engine
// itself never reads process.versions, so omitting it costs nothing.
const browserProcess = {
  env: Object.create(null) as Record<string, string | undefined>,
  platform: "browser",
  argv: ["browser", "codeindex"],
  cwd: () => "/",
  exit: (code?: number) => {
    throw new Error(`process.exit(${code ?? 0}) is not available in the browser build`);
  },
  hrtime: Object.assign((previous?: [number, number]): [number, number] => {
    const now = performance.now();
    const seconds = Math.floor(now / 1000);
    const nanos = Math.floor((now % 1000) * 1e6);
    if (!previous) return [seconds, nanos];
    return [seconds - previous[0]!, nanos - previous[1]!];
  }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  stdout: { write: (chunk: string) => (console.log(chunk.replace(/\n$/, "")), true), isTTY: false },
  stderr: { write: (chunk: string) => (console.warn(chunk.replace(/\n$/, "")), true), isTTY: false },
  on: () => browserProcess,
  emitWarning: (warning: string) => console.warn(warning),
};

export { BrowserBuffer as Buffer, browserProcess as process };
