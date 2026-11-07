import type { Text } from '@codemirror/state';

/**
 * Line separator the editor should use so that `doc.toString()` reproduces the source exactly.
 * Uniform CRLF/CR/LF files use that separator; mixed files use LF and keep stray `\r` as visible
 * characters, which also keeps positions identical to string offsets.
 */
export function chooseLineSeparator(text: string): '\n' | '\r\n' | '\r' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r/g) ?? []).length - crlf;
  if (crlf > 0 && lf === 0 && cr === 0) return '\r\n';
  if (cr > 0 && lf === 0 && crlf === 0) return '\r';
  return '\n';
}

/**
 * Converts between CodeMirror positions (each line break counts as 1) and UTF-16 offsets in the
 * source string (a CRLF break counts as 2).
 */
export class OffsetMapper {
  private readonly extra: number;

  constructor(separator: string) {
    this.extra = separator.length - 1;
  }

  toOffset(doc: Text, pos: number): number {
    if (this.extra === 0) return pos;
    return pos + (doc.lineAt(pos).number - 1) * this.extra;
  }

  toPos(doc: Text, offset: number): number {
    if (this.extra === 0) return offset;
    // Binary search for the last line whose start offset is <= offset.
    let lo = 1;
    let hi = doc.lines;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (doc.line(mid).from + (mid - 1) * this.extra <= offset) lo = mid;
      else hi = mid - 1;
    }
    const line = doc.line(lo);
    const lineStart = line.from + (lo - 1) * this.extra;
    // Offsets inside a CRLF pair clamp to the line end.
    return Math.min(line.to, line.from + (offset - lineStart));
  }
}
