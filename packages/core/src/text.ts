import { AppError } from './errors.ts';

/** A replacement of `source.slice(from, to)` with `insert`. Offsets are UTF-16 code unit indices. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/**
 * Applies non-overlapping edits expressed against the *original* text. Edits may be given in any
 * order; overlapping or out-of-range edits are rejected rather than guessed at.
 */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  let out = '';
  let pos = 0;
  for (const edit of sorted) {
    if (edit.from < pos || edit.from > edit.to || edit.to > text.length) {
      throw new AppError('edit.invalid_range', { from: edit.from, to: edit.to, length: text.length });
    }
    out += text.slice(pos, edit.from) + edit.insert;
    pos = edit.to;
  }
  return out + text.slice(pos);
}

export type LineEnding = '\n' | '\r\n';

/** Predominant line ending; LF when there are no line breaks or they are tied. */
export function detectLineEnding(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

const BOM = '﻿';

export interface DecodedText {
  text: string;
  bom: boolean;
}

/**
 * Decodes file bytes as UTF-8, remembering whether a BOM was present so saving can write it back.
 * Invalid UTF-8 is rejected instead of being replaced with U+FFFD, which would corrupt the file on
 * save.
 */
export function decodeUtf8(bytes: Uint8Array): DecodedText {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw new AppError('file.not_utf8', {}, cause);
  }
  if (text.startsWith(BOM)) return { text: text.slice(1), bom: true };
  return { text, bom: false };
}

export function encodeUtf8(decoded: DecodedText): Uint8Array {
  return new TextEncoder().encode(decoded.bom ? BOM + decoded.text : decoded.text);
}

/** Splits text into lines keeping each line's terminator, so joining the result is lossless. */
export function splitLinesKeepEnds(text: string): string[] {
  if (text === '') return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
