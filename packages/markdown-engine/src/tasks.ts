import { AppError, fingerprint, type TextEdit } from '@mdr/core';

const UNCHECKED = new Set([' ', '\t']);
const CHECKED = new Set(['x', 'X']);

/**
 * Builds the single-character edit that toggles the task whose check value sits at `offset`.
 *
 * Guarantees: the source must be exactly the text the caller rendered (`expectedFingerprint`),
 * and the offset must point inside a `[?]` marker. Nothing else in the document is touched, so
 * formatting, line endings and unknown syntax are preserved.
 */
export function toggleTask(source: string, offset: number, expectedFingerprint: string, checked?: boolean): TextEdit {
  if (fingerprint(source) !== expectedFingerprint) {
    throw new AppError('edit.stale_revision', { offset });
  }
  const value = source[offset];
  if (
    value === undefined ||
    source[offset - 1] !== '[' ||
    source[offset + 1] !== ']' ||
    !(UNCHECKED.has(value) || CHECKED.has(value))
  ) {
    throw new AppError('edit.marker_mismatch', { offset });
  }
  const next = checked ?? !CHECKED.has(value);
  return { from: offset, to: offset + 1, insert: next ? 'x' : ' ' };
}

/**
 * Re-maps a task offset through a set of edits applied after rendering (e.g. typing in the editor
 * while the preview is stale). Returns null when the edit touched the marker itself.
 */
export function mapOffset(offset: number, edits: readonly TextEdit[]): number | null {
  let delta = 0;
  for (const edit of edits) {
    if (edit.to <= offset) {
      delta += edit.insert.length - (edit.to - edit.from);
    } else if (edit.from <= offset) {
      return null;
    }
  }
  return offset + delta;
}
