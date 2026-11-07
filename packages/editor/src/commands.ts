import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';

/** Wraps each selection in `before`/`after`, or removes the wrapping if already present. */
export function toggleWrap(before: string, after = before): Command {
  return (view: EditorView) => {
    const { state } = view;
    const tr = state.changeByRange((range) => {
      const outerFrom = range.from - before.length;
      const outerTo = range.to + after.length;
      if (outerFrom >= 0 && state.sliceDoc(outerFrom, range.from) === before && state.sliceDoc(range.to, outerTo) === after) {
        return {
          changes: [
            { from: outerFrom, to: range.from },
            { from: range.to, to: outerTo },
          ],
          range: EditorSelection.range(outerFrom, range.to - before.length),
        };
      }
      return {
        changes: [
          { from: range.from, insert: before },
          { from: range.to, insert: after },
        ],
        range: EditorSelection.range(range.from + before.length, range.to + before.length),
      };
    });
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

/** Adds `prefix` to every selected line, or removes it when all lines already have it. */
export function toggleLinePrefix(prefix: string, pattern: RegExp): Command {
  return (view: EditorView) => {
    const { state } = view;
    const lines = new Set<number>();
    for (const range of state.selection.ranges) {
      for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) lines.add(n);
    }
    const all = [...lines].map((n) => state.doc.line(n));
    const remove = all.every((line) => pattern.test(line.text));
    const changes: ChangeSpec[] = all.map((line) => {
      if (remove) {
        const match = pattern.exec(line.text)!;
        return { from: line.from + (match.index ?? 0), to: line.from + (match.index ?? 0) + match[0].length };
      }
      const indent = /^\s*/.exec(line.text)![0].length;
      return { from: line.from + indent, insert: prefix };
    });
    view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.format' });
    return true;
  };
}

export function insertLink(view: EditorView, image = false): boolean {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const label = state.sliceDoc(range.from, range.to);
    const text = `${image ? '!' : ''}[${label}](url)`;
    const urlStart = range.from + text.length - 4;
    return { changes: { from: range.from, to: range.to, insert: text }, range: EditorSelection.range(urlStart, urlStart + 3) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
  return true;
}

export const formatCommands = {
  bold: toggleWrap('**'),
  italic: toggleWrap('_'),
  strikethrough: toggleWrap('~~'),
  code: toggleWrap('`'),
  heading: toggleLinePrefix('## ', /^\s*#{1,6} /),
  quote: toggleLinePrefix('> ', /^\s*> ?/),
  bulletList: toggleLinePrefix('- ', /^\s*[-*+] (?!\[[ xX]\] )/),
  taskList: toggleLinePrefix('- [ ] ', /^\s*[-*+] \[[ xX]\] /),
  link: (view: EditorView) => insertLink(view, false),
  image: (view: EditorView) => insertLink(view, true),
} satisfies Record<string, Command>;

export type FormatCommand = keyof typeof formatCommands;
