import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from './errors.ts';
import { diffAsEdit, invertEdits, TextHistory } from './history.ts';
import { DocumentSession, type SaveFn } from './session.ts';
import { applyEdits } from './text.ts';

describe('TextHistory', () => {
  it('inverts multi-edit changes', () => {
    const before = 'hello world';
    const edits = [{ from: 0, to: 5, insert: 'bye' }, { from: 6, to: 11, insert: 'всем' }];
    const after = applyEdits(before, edits);
    expect(applyEdits(after, invertEdits(before, edits))).toBe(before);
  });

  it('groups rapid typing and seals on demand', () => {
    const h = new TextHistory({ groupWindowMs: 1000 });
    let text = '';
    for (const [i, ch] of [...'abc'].entries()) {
      const edits = [{ from: text.length, to: text.length, insert: ch }];
      h.record(text, edits, 'typing', 1000 + i * 100);
      text = applyEdits(text, edits);
    }
    const undo = h.undo();
    expect(undo).not.toBeNull();
    expect(applyEdits(text, undo!)).toBe('');
    expect(applyEdits('', h.redo()!)).toBe('abc');
  });

  it('computes minimal diffs', () => {
    expect(diffAsEdit('abcdef', 'abXYef')).toEqual({ from: 2, to: 4, insert: 'XY' });
    expect(diffAsEdit('same', 'same')).toEqual({ from: 4, to: 4, insert: '' });
  });
});

describe('DocumentSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeStore(initial: string) {
    const store = { text: initial, version: 1 };
    const save: SaveFn = vi.fn(async (text, base) => {
      if (String(store.version) !== base) throw new AppError('file.external_change');
      store.text = text;
      store.version++;
      return String(store.version);
    });
    return { store, save };
  }

  it('autosaves after the debounce and keeps undo after save', async () => {
    const { store, save } = makeStore('- [ ] a\n');
    const session = new DocumentSession({ text: store.text, version: '1', save, autosaveDelayMs: 500 });
    session.apply([{ from: 3, to: 4, insert: 'x' }], 'task');
    expect(session.saveState.kind).toBe('dirty');
    await vi.advanceTimersByTimeAsync(500);
    expect(store.text).toBe('- [x] a\n');
    expect(session.saveState.kind).toBe('saved');

    expect(session.undo()).toBe(true);
    expect(session.text).toBe('- [ ] a\n');
    await vi.advanceTimersByTimeAsync(500);
    expect(store.text).toBe('- [ ] a\n');
    expect(session.redo()).toBe(true);
    await session.flush();
    expect(store.text).toBe('- [x] a\n');
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('enters conflict instead of overwriting an externally changed file', async () => {
    const { store, save } = makeStore('one');
    const session = new DocumentSession({ text: store.text, version: '1', save });
    store.text = 'changed elsewhere';
    store.version = 7;
    session.apply([{ from: 0, to: 3, insert: 'two' }], 'editor');
    await session.flush();
    expect(session.saveState.kind).toBe('conflict');
    expect(store.text).toBe('changed elsewhere');
    expect(() => session.apply([{ from: 0, to: 0, insert: 'x' }], 'editor')).toThrow(/file.external_change/);

    session.replaceFromExternal(store.text, '7');
    expect(session.text).toBe('changed elsewhere');
    expect(session.saveState.kind).toBe('saved');
    // The user's version is one undo away.
    session.undo();
    expect(session.text).toBe('two');
  });

  it('serialises saves and saves again if edits arrive during a save', async () => {
    let release: () => void = () => {};
    const calls: string[] = [];
    const save: SaveFn = (text) =>
      new Promise((resolve) => {
        calls.push(text);
        release = () => resolve(String(calls.length + 1));
      });
    const session = new DocumentSession({ text: '', version: '1', save, autosaveDelayMs: 10 });
    session.apply([{ from: 0, to: 0, insert: 'a' }], 'editor');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(['a']);
    session.apply([{ from: 1, to: 1, insert: 'b' }], 'editor');
    release();
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toEqual(['a', 'ab']);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.saveState.kind).toBe('saved');
  });

  it('notifies listeners with the edit origin', () => {
    const session = new DocumentSession({ text: 'x', version: '1', save: async () => '2' });
    const origins: string[] = [];
    session.subscribe((e) => e && origins.push(e.origin));
    session.apply([{ from: 1, to: 1, insert: 'y' }], 'editor');
    session.undo();
    expect(origins).toEqual(['editor', 'history']);
  });
});
