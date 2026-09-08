// Shared decoding and byte-coordinate mechanics for index and inventory consumers.
import { readFileSync } from 'node:fs'

export type Encoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'latin1'

export interface TextRead {
  /** Decoded text. Empty string when `ok` is false or the file is genuinely empty. */
  text: string
  /** Raw bytes as read. Byte offsets in the inventory index into THIS buffer. */
  buf: Uint8Array
  encoding: Encoding | null
  /** True when a NUL byte was found outside a BOM-declared UTF-16 file. */
  binary: boolean
  bytes: number
  /** False when the file could not be read (vanished, permissions, EISDIR). */
  ok: boolean
  /**
   * Whether byte offsets computed from `text` address `buf` directly.
   *
   * True for utf8 and utf8-bom (the BOM is stripped from `text`, so offsets
   * carry a +3 shift the caller must apply via `bodyStart`). False for UTF-16
   * and latin1, where a decoded-string offset is not a file-byte offset. Those
   * files are still inventoried, but `apply` refuses to patch them rather than
   * writing at a plausible-looking wrong offset.
   */
  byteAddressable: boolean
  /** Offset in `buf` at which `text` begins — 3 for utf8-bom, 2 for UTF-16, else 0. */
  bodyStart: number
}

const EMPTY: TextRead = {
  text: '',
  buf: Buffer.alloc(0),
  encoding: null,
  binary: false,
  bytes: 0,
  ok: false,
  byteAddressable: false,
  bodyStart: 0,
}

export function readTextEx(abs: string): TextRead {
  let buf: Buffer
  try {
    buf = readFileSync(abs)
  } catch {
    return EMPTY
  }
  const bytes = buf.length
  const base = { buf, bytes, ok: true, binary: false }

  if (bytes >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const text = buf.subarray(2, 2 + ((bytes - 2) & ~1)).toString('utf16le')
    return { ...base, text, encoding: 'utf16le', byteAddressable: false, bodyStart: 2 }
  }
  if (bytes >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2, 2 + ((bytes - 2) & ~1)))
    swapped.swap16() // UTF-16BE → LE so Node can decode it
    return {
      ...base,
      text: swapped.toString('utf16le'),
      encoding: 'utf16be',
      byteAddressable: false,
      bodyStart: 2,
    }
  }
  if (bytes >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return {
      ...base,
      text: buf.subarray(3).toString('utf8'),
      encoding: 'utf8-bom',
      byteAddressable: true,
      bodyStart: 3,
    }
  }
  if (buf.includes(0)) {
    return { ...base, text: '', encoding: null, binary: true, byteAddressable: false, bodyStart: 0 }
  }
  const text = buf.toString('utf8')
  if (text.includes('�')) {
    // Invalid UTF-8. A latin1/Windows-1252 source decodes cleanly (every byte
    // maps to a code point), which beats baking mojibake into the inventory —
    // but a decoded-char offset is then not a file-byte offset.
    return {
      ...base,
      text: buf.toString('latin1'),
      encoding: 'latin1',
      byteAddressable: false,
      bodyStart: 0,
    }
  }
  return { ...base, text, encoding: 'utf8', byteAddressable: true, bodyStart: 0 }
}

/**
 * Maps between JS string indices (UTF-16 code units) and UTF-8 byte offsets.
 *
 * Tree-sitter reports byte offsets; the hand-written lexers scan JS strings.
 * Both feed one inventory, so exactly one coordinate system can survive, and it
 * has to be bytes — that is what the patcher writes at. Getting this wrong is
 * silent corruption on any file containing an accented character or an emoji,
 * which for this tool is most of them.
 *
 * Pure-ASCII files take the identity fast path and allocate nothing, which is
 * the overwhelmingly common case.
 */
export class OffsetMap {
  private readonly ascii: boolean
  /** charToByteTable[i] = byte offset of char index i. Length = text.length + 1. */
  private readonly table: Int32Array | null
  private readonly lineStarts: Int32Array

  constructor(private readonly text: string) {
    // eslint-disable-next-line no-control-regex
    this.ascii = !/[^\x00-\x7F]/.test(text)
    this.table = this.ascii ? null : buildCharToByte(text)
    this.lineStarts = buildLineStarts(text)
  }

  /** UTF-8 byte offset of a JS string index. */
  byteOf(charIndex: number): number {
    if (this.ascii) return charIndex
    const t = this.table!
    if (charIndex <= 0) return 0
    if (charIndex >= t.length) return t[t.length - 1]!
    return t[charIndex]!
  }

  /** 1-based line and 1-based column (in UTF-16 code units, matching editors). */
  lineColOf(charIndex: number): { line: number; col: number } {
    const ls = this.lineStarts
    let lo = 0
    let hi = ls.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ls[mid]! <= charIndex) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, col: charIndex - ls[lo]! + 1 }
  }

  get lineCount(): number {
    return this.lineStarts.length
  }
}

function buildCharToByte(text: string): Int32Array {
  const table = new Int32Array(text.length + 1)
  let byte = 0
  for (let i = 0; i < text.length; i++) {
    table[i] = byte
    const code = text.charCodeAt(i)
    if (code < 0x80) byte += 1
    else if (code < 0x800) byte += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      // Surrogate pair: one 4-byte code point spanning two UTF-16 units. The
      // low surrogate gets the same offset as its pair's tail so that slicing
      // mid-pair — which would be a bug anyway — cannot silently shift.
      table[i + 1] = byte
      byte += 4
      i++
    } else byte += 3
  }
  table[text.length] = byte
  return table
}

function buildLineStarts(text: string): Int32Array {
  const starts: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return Int32Array.from(starts)
}
