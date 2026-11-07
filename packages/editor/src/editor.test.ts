import { Text } from '@codemirror/state';
import { applyEdits, DocumentSession } from '@mdr/core';
import { render, toggleTask } from '@mdr/markdown-engine';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseLineSeparator, createMarkdownEditor, OffsetMapper, type MarkdownEditor } from './index.ts';

describe('line separators and offsets', () => {
  it('chooses a separator that round-trips the source', () => {
    expect(chooseLineSeparator('a\r\nb\r\n')).toBe('\r\n');
    expect(chooseLineSeparator('a\nb')).toBe('\n');
    expect(chooseLineSeparator('a\r\nb\nc')).toBe('\n');
    expect(chooseLineSeparator('a\rb')).toBe('\r');
  });

  it('maps CRLF offsets to positions and back', () => {
    const source = 'ab\r\ncd\r\n\r\nef';
    const doc = Text.of(source.split('\r\n'));
    const mapper = new OffsetMapper('\r\n');
    for (const [offset, char] of [[0, 'a'], [4, 'c'], [5, 'd'], [10, 'e']] as const) {
      const pos = mapper.toPos(doc, offset);
      expect(doc.sliceString(pos, pos + 1)).toBe(char);
      expect(mapper.toOffset(doc, pos)).toBe(offset);
    }
  });
});

describe('editor ↔ session binding', () => {
  let editor: MarkdownEditor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function setup(text: string) {
    const session = new DocumentSession({ text, version: '1', save: async () => '2', autosaveDelayMs: 60_000 });
    const parent = document.createElement('div');
    document.body.append(parent);
    editor = createMarkdownEditor({ parent, session, options: { lineNumbers: true, wrap: true }, ariaLabel: 'source' });
    return { session, view: editor.view };
  }

  it('keeps CRLF documents byte-identical through typing and task toggles', () => {
    const source = '# Список\r\n\r\n- [ ] один\r\n- [ ] два\r\n';
    const { session, view } = setup(source);
    expect(view.state.sliceDoc()).toBe(source);

    // Toggle the second task from the "reader".
    const { tasks, sourceFingerprint } = render(session.text);
    session.apply([toggleTask(session.text, tasks[1]!.offset, sourceFingerprint)], 'task');
    expect(session.text).toBe(source.replace('- [ ] два', '- [x] два'));
    expect(view.state.sliceDoc()).toBe(session.text);

    // Type at the end of line 3 in the editor.
    const line = view.state.doc.line(3);
    view.dispatch({ changes: { from: line.to, insert: '!' } });
    expect(session.text).toBe('# Список\r\n\r\n- [ ] один!\r\n- [x] два\r\n');

    // Insert a new line via the editor: it must use CRLF.
    view.dispatch({ changes: { from: view.state.doc.line(3).to, insert: view.state.lineBreak + '- [ ] три' } });
    expect(session.text).toBe('# Список\r\n\r\n- [ ] один!\r\n- [ ] три\r\n- [x] два\r\n');
  });

  it('undo covers editor typing and checkbox toggles in order', () => {
    const source = '- [ ] a\n';
    const { session, view } = setup(source);
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'more' } });
    const { tasks, sourceFingerprint } = render(session.text);
    session.apply([toggleTask(session.text, tasks[0]!.offset, sourceFingerprint)], 'task');
    expect(session.text).toBe('- [x] a\nmore');
    session.undo();
    expect(view.state.sliceDoc()).toBe('- [ ] a\nmore');
    session.undo();
    expect(view.state.sliceDoc()).toBe(source);
    session.redo();
    session.redo();
    expect(view.state.sliceDoc()).toBe('- [x] a\nmore');
  });

  it('applies formatting commands as undoable edits', () => {
    const { session, view } = setup('word');
    view.dispatch({ selection: { anchor: 0, head: 4 } });
    editor!.format('bold');
    expect(session.text).toBe('**word**');
    editor!.format('bold');
    expect(session.text).toBe('word');
    view.dispatch({ selection: { anchor: 0 } });
    editor!.format('taskList');
    expect(session.text).toBe('- [ ] word');
    expect(applyEdits(session.text, [])).toBe('- [ ] word');
  });
});
