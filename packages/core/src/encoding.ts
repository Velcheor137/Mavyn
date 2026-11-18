import { detect } from 'chardet';
import { AppError } from './errors.ts';

/**
 * Text files in any common encoding. A document keeps its text as a JS string (stored and synced as
 * UTF-8, hashed as UTF-8); the original encoding and BOM live on the document and are used only when
 * bytes leave Mavyn again (linked save, download). Labels are WHATWG encoding names.
 */
export interface DecodedFile {
  text: string;
  /** Canonical WHATWG label, e.g. `utf-8`, `utf-16le`, `windows-1251`. */
  encoding: string;
  bom: boolean;
}

/** Encodings offered for "Reopen with / Save with encoding", most common first. */
export const TEXT_ENCODINGS = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'windows-1251',
  'koi8-r',
  'koi8-u',
  'ibm866',
  'windows-1252',
  'windows-1250',
  'iso-8859-2',
  'iso-8859-5',
  'windows-1253',
  'windows-1254',
  'windows-1255',
  'windows-1256',
  'windows-1257',
  'windows-1258',
  'windows-874',
  'shift_jis',
  'euc-jp',
  'euc-kr',
  'big5',
  'gbk',
  'gb18030',
] as const;

const BOM = '﻿';
/** Bytes inspected for NUL when deciding "text or binary". */
const SNIFF_BYTES = 64 * 1024;

/** Canonical WHATWG name of `label`, or null when the platform cannot decode it. */
export function canonicalEncoding(label: string): string | null {
  try {
    const name = new TextDecoder(label).encoding;
    // `replacement` is what WHATWG maps unsafe encodings (ISO-2022-KR/CN, HZ) to: not decodable.
    return name === 'replacement' ? null : name;
  } catch {
    return null;
  }
}

function bomOf(bytes: Uint8Array): { encoding: string; length: number } | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: 'utf-8', length: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', length: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', length: 2 };
  return null;
}

/**
 * Decides whether `bytes` is text and decodes it. Order: BOM, strict UTF-8, then statistical
 * detection. A NUL byte (without a UTF-16 BOM) means binary: `file.unsupported`.
 */
export function detectText(bytes: Uint8Array): DecodedFile {
  const bom = bomOf(bytes);
  if (bom) return decodeAs(bytes, bom.encoding);
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) throw new AppError('file.unsupported', { reason: 'binary' });
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', bom: false };
  } catch {
    // Not UTF-8: fall through to detection.
  }
  const guess = detect(bytes.subarray(0, 4 * 1024 * 1024));
  // UTF-32 has no WHATWG decoder; such files are not plain text for our purposes.
  if (guess?.startsWith('UTF-32')) throw new AppError('file.unsupported', { reason: 'encoding' });
  // "Almost UTF-8" (a few broken bytes) or no guess: windows-1252 maps every byte to a character,
  // so saving writes the same bytes back. The user can pick the right encoding manually.
  const detected = guess ? canonicalEncoding(guess) : null;
  return decodeAs(bytes, detected && detected !== 'utf-8' ? detected : 'windows-1252');
}

/** Decodes with an explicit encoding (manual "Reopen with encoding"). Never throws on bad bytes. */
export function decodeAs(bytes: Uint8Array, label: string): DecodedFile {
  const encoding = canonicalEncoding(label);
  if (!encoding) throw new AppError('file.unsupported', { reason: 'encoding', encoding: label });
  const bom = bomOf(bytes);
  const hasBom = bom !== null && bom.encoding === encoding;
  const text = new TextDecoder(encoding, { ignoreBOM: true }).decode(hasBom ? bytes.subarray(bom.length) : bytes);
  return { text: text.startsWith(BOM) ? text.slice(1) : text, encoding, bom: hasBom };
}

/**
 * Encodes `text` back into its file encoding. Characters the encoding cannot represent throw
 * `file.unencodable` (with the offset) instead of being replaced: saving must never lose text.
 */
export function encodeText(text: string, label = 'utf-8', bom = false): Uint8Array {
  const encoding = canonicalEncoding(label) ?? label;
  if (encoding === 'utf-8') return new TextEncoder().encode(bom ? BOM + text : text);
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return encodeUtf16(text, encoding === 'utf-16le', bom);
  const table = reverseTable(encoding);
  const out = new Uint8Array(text.length * 2);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80 && table.ascii) {
      out[n++] = code;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const char = String.fromCodePoint(cp);
    const bytes = table.map.get(char);
    if (!bytes) throw new AppError('file.unencodable', { encoding, offset: i, char });
    for (const b of bytes) out[n++] = b;
    if (cp > 0xffff) i++;
  }
  return out.slice(0, n);
}

function encodeUtf16(text: string, littleEndian: boolean, bom: boolean): Uint8Array {
  const source = bom ? BOM + text : text;
  const out = new Uint8Array(source.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < source.length; i++) view.setUint16(i * 2, source.charCodeAt(i), littleEndian);
  return out;
}

interface ReverseTable {
  /** Bytes 0x00–0x7F are ASCII (true for every supported legacy encoding except ISO-2022). */
  ascii: boolean;
  map: Map<string, number[]>;
}

const tables = new Map<string, ReverseTable>();
/** Two-byte CJK encodings (EUC-JP three-byte and GB18030 four-byte sequences are not written). */
const MULTIBYTE = new Set(['shift_jis', 'euc-jp', 'euc-kr', 'big5', 'gbk', 'gb18030']);

/**
 * Character → bytes map built from the platform decoder, so encoding is exactly the inverse of
 * decoding. Single bytes first, then two-byte sequences (CJK). Built lazily once per encoding.
 */
function reverseTable(encoding: string): ReverseTable {
  const cached = tables.get(encoding);
  if (cached) return cached;
  if (encoding === 'iso-2022-jp' || !canonicalEncoding(encoding)) throw new AppError('file.unencodable', { encoding });
  const decoder = new TextDecoder(encoding);
  const map = new Map<string, number[]>();
  const put = (char: string, bytes: number[]) => {
    if (char.length > 0 && !char.includes('�') && !map.has(char)) map.set(char, bytes);
  };
  const asciiProbe = new Uint8Array(128).map((_, i) => i);
  const ascii = decoder.decode(asciiProbe) === String.fromCharCode(...asciiProbe);
  // Some decoders (e.g. ICU's Shift_JIS: 0x5C → ¥) differ from ASCII; then map those bytes too.
  for (let b = ascii ? 0x80 : 0x00; b <= 0xff; b++) {
    const char = decoder.decode(new Uint8Array([b]));
    if ([...char].length === 1) put(char, [b]);
  }
  for (let lead = 0x81; MULTIBYTE.has(encoding) && lead <= 0xfe; lead++) {
    if (map.has(decoder.decode(new Uint8Array([lead])))) continue;
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      const char = decoder.decode(new Uint8Array([lead, trail]));
      if ([...char].length === 1) put(char, [lead, trail]);
    }
  }
  const table = { ascii, map };
  tables.set(encoding, table);
  return table;
}

/** Bytes of a text document as they go back to disk or a download (its encoding and BOM). */
export function encodeDocumentText(text: string, meta: { encoding?: string; bom: boolean }): Uint8Array {
  return encodeText(text, meta.encoding ?? 'utf-8', meta.bom);
}
