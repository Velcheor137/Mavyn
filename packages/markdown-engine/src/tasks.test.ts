import { applyEdits, fingerprint } from '@mdr/core';
import { describe, expect, it } from 'vitest';
import { render, toggleTask, mapOffset } from './index.ts';

function toggleAt(source: string, index: number): string {
  const { tasks, sourceFingerprint } = render(source);
  const task = tasks[index];
  if (!task) throw new Error(`no task #${index}`);
  return applyEdits(source, [toggleTask(source, task.offset, sourceFingerprint)]);
}

describe('task offsets', () => {
  it('finds every task with exact offsets in document order', () => {
    const source = '- [ ] First task\n- [x] Completed task\n- [ ] Another task\n';
    const { tasks } = render(source);
    expect(tasks.map((t) => [source[t.offset - 1], source[t.offset], source[t.offset + 1]])).toEqual([
      ['[', ' ', ']'],
      ['[', 'x', ']'],
      ['[', ' ', ']'],
    ]);
    expect(tasks.map((t) => t.checked)).toEqual([false, true, false]);
    expect(tasks.map((t) => t.line)).toEqual([1, 2, 3]);
  });

  it('toggles only the clicked task among duplicate labels', () => {
    const source = '- [ ] same\n- [ ] same\n- [ ] same\n';
    expect(toggleAt(source, 1)).toBe('- [ ] same\n- [x] same\n- [ ] same\n');
    expect(toggleAt(source, 2)).toBe('- [ ] same\n- [ ] same\n- [x] same\n');
  });

  it('handles nesting, ordered markers, alternate bullets and blockquotes', () => {
    const source = [
      '1. [ ] parent',
      '   - [X] child',
      '     * [ ] grandchild',
      '2) [ ] paren',
      '+ [ ] plus',
      '> - [ ] quoted',
      '>   - [x] quoted child',
      '',
    ].join('\n');
    const { tasks } = render(source);
    expect(tasks).toHaveLength(7);
    expect(toggleAt(source, 1)).toContain('   - [ ] child');
    expect(toggleAt(source, 2)).toContain('     * [x] grandchild');
    expect(toggleAt(source, 5)).toContain('> - [x] quoted');
    expect(toggleAt(source, 6)).toContain('>   - [ ] quoted child');
    for (let i = 0; i < tasks.length; i++) {
      const out = toggleAt(source, i);
      expect(out.length).toBe(source.length);
      const diff = [...source].filter((ch, k) => ch !== out[k]).length;
      expect(diff).toBe(1);
    }
  });

  it('preserves CRLF, Unicode, emoji and surrounding formatting byte-for-byte', () => {
    const source = '# Список дел 📝\r\n\r\n- [ ] Купить молоко 🥛  \r\n- [x] **Сделать** _ДЗ_ <br>\r\n\t- [ ] Вложенная задача\r\n';
    const toggled = toggleAt(source, 0);
    expect(toggled).toBe(source.replace('- [ ] Купить', '- [x] Купить'));
    const back = toggleAt(toggled, 0);
    expect(back).toBe(source);
    expect(toggleAt(source, 1)).toBe(source.replace('- [x] **Сделать**', '- [ ] **Сделать**'));
  });

  it('does not treat checkbox-like text or code as tasks', () => {
    const source = '- not a task [ ]\n\n```\n- [ ] in code\n```\n\n`- [ ] inline`\n\n- [ ]\n- [ ]no space\n';
    const { tasks } = render(source);
    expect(tasks).toHaveLength(0);
  });

  it('keeps tasks inside footnotes and tables of other content mapped to source', () => {
    const source = 'Text[^1]\n\n[^1]: Note\n\n    - [ ] in footnote\n\n- [ ] after\n';
    const { tasks } = render(source);
    expect(tasks.map((t) => source.slice(t.offset - 1, t.offset + 2))).toEqual(['[ ]', '[ ]']);
    expect(toggleAt(source, 0)).toContain('    - [x] in footnote');
  });

  it('rejects stale revisions and mismatched offsets', () => {
    const source = '- [ ] a\n';
    const { tasks, sourceFingerprint } = render(source);
    const edited = `x${source}`;
    expect(() => toggleTask(edited, tasks[0]!.offset, sourceFingerprint)).toThrow(/edit.stale_revision/);
    expect(() => toggleTask(source, 0, sourceFingerprint)).toThrow(/edit.marker_mismatch/);
    expect(() => toggleTask(source, 999, fingerprint(source))).toThrow(/edit.marker_mismatch/);
  });

  it('supports explicit target state for idempotent toggles', () => {
    const source = '- [x] done\n';
    const { tasks, sourceFingerprint } = render(source);
    expect(toggleTask(source, tasks[0]!.offset, sourceFingerprint, true)).toEqual({ from: 3, to: 4, insert: 'x' });
  });

  it('maps offsets through later edits', () => {
    expect(mapOffset(10, [{ from: 0, to: 0, insert: 'abc' }])).toBe(13);
    expect(mapOffset(10, [{ from: 20, to: 25, insert: '' }])).toBe(10);
    expect(mapOffset(10, [{ from: 9, to: 11, insert: 'z' }])).toBeNull();
  });

  it('scales to large documents with hundreds of tasks', () => {
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) lines.push(`- [${i % 3 === 0 ? 'x' : ' '}] Задача номер ${i} с **жирным** текстом`);
    const source = `${lines.join('\n')}\n`;
    const started = performance.now();
    const { tasks } = render(source);
    const elapsed = performance.now() - started;
    expect(tasks).toHaveLength(2000);
    expect(toggleAt(source, 1999)).toContain('- [x] Задача номер 1999');
    // Generous bound: catches accidental quadratic behaviour, not a performance budget.
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);
});
