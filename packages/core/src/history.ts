import { applyEdits, type TextEdit } from './text.ts';

interface Entry {
  /** Edits against the text before the entry. */
  forward: TextEdit[];
  /** Edits against the text after the entry that restore the previous text. */
  inverse: TextEdit[];
  at: number;
  group: string | null;
}

/** Inverse of `edits` (expressed against `before`) as edits against the result text. */
export function invertEdits(before: string, edits: readonly TextEdit[]): TextEdit[] {
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  const inverse: TextEdit[] = [];
  let delta = 0;
  for (const edit of sorted) {
    const from = edit.from + delta;
    inverse.push({ from, to: from + edit.insert.length, insert: before.slice(edit.from, edit.to) });
    delta += edit.insert.length - (edit.to - edit.from);
  }
  return inverse;
}

export interface HistoryOptions {
  /** Consecutive edits of the same group within this window merge into one undo step. */
  groupWindowMs?: number;
  limit?: number;
}

/**
 * Undo/redo history over plain text. Independent of saving, so undo keeps working after autosave
 * and covers edits from every source (editor typing, task toggles, merges).
 */
export class TextHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private readonly groupWindowMs: number;
  private readonly limit: number;

  constructor(options: HistoryOptions = {}) {
    this.groupWindowMs = options.groupWindowMs ?? 750;
    this.limit = options.limit ?? 500;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Records edits that turned `before` into the current text. */
  record(before: string, edits: readonly TextEdit[], group: string | null = null, now = Date.now()): void {
    if (edits.length === 0) return;
    const after = applyEdits(before, edits);
    const inverse = invertEdits(before, edits);
    const last = this.undoStack.at(-1);
    this.redoStack = [];

    if (last && group !== null && last.group === group && now - last.at <= this.groupWindowMs) {
      // Merge: forward = (before-of-last → after), stored as a full-range replacement against the
      // text before `last`, computed lazily from inverses to keep entries small.
      const original = applyEdits(before, last.inverse);
      last.forward = [diffAsEdit(original, after)];
      last.inverse = [diffAsEdit(after, original)];
      last.at = now;
      return;
    }

    this.undoStack.push({ forward: [...edits], inverse, at: now, group });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  /** Returns the edits to apply to the current text to undo, or null. */
  undo(): TextEdit[] | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return entry.inverse;
  }

  redo(): TextEdit[] | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return entry.forward;
  }

  /** Breaks grouping so the next edit starts a new undo step. */
  seal(): void {
    const last = this.undoStack.at(-1);
    if (last) last.group = null;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/** Minimal single edit turning `a` into `b` (common prefix/suffix trimmed). */
export function diffAsEdit(a: string, b: string): TextEdit {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}
