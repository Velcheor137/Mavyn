import { describe, expect, it } from 'vitest';
import {
  AppError,
  applyEdits,
  compareNames,
  decodeUtf8,
  deriveTitle,
  detectLineEnding,
  encodeUtf8,
  fingerprint,
  foldKey,
  isUuid,
  sha256Hex,
  splitLinesKeepEnds,
  threeWayMerge,
  uuidv7,
} from './index.ts';

describe('uuidv7', () => {
  it('produces valid, time-ordered, unique ids', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => uuidv7(1_700_000_000_000 + Math.floor(i / 100)));
    expect(ids.every(isUuid)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]![14]).toBe('7');
  });
});

describe('hashing', () => {
  it('sha256 matches a known vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('fingerprint differs on single-char change and is stable', () => {
    expect(fingerprint('- [ ] a')).not.toBe(fingerprint('- [x] a'));
    expect(fingerprint('Привет')).toBe(fingerprint('Привет'));
  });
});

describe('applyEdits', () => {
  it('applies unordered non-overlapping edits against the original', () => {
    expect(applyEdits('hello world', [{ from: 6, to: 11, insert: 'мир' }, { from: 0, to: 5, insert: 'привет' }])).toBe('привет мир');
  });
  it('rejects overlap and out-of-range', () => {
    expect(() => applyEdits('abc', [{ from: 0, to: 2, insert: '' }, { from: 1, to: 3, insert: '' }])).toThrow(AppError);
    expect(() => applyEdits('abc', [{ from: 2, to: 9, insert: '' }])).toThrow(AppError);
  });
});

describe('line endings and encoding', () => {
  it('detects predominant line endings', () => {
    expect(detectLineEnding('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectLineEnding('a\nb')).toBe('\n');
    expect(detectLineEnding('single')).toBe('\n');
  });
  it('round-trips BOM and rejects invalid UTF-8', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Заголовок')]);
    const decoded = decodeUtf8(bytes);
    expect(decoded).toEqual({ text: '# Заголовок', bom: true });
    expect(encodeUtf8(decoded)).toEqual(bytes);
    expect(() => decodeUtf8(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(/file.not_utf8/);
  });
  it('splits lines losslessly', () => {
    const text = 'a\r\nb\n\nc';
    expect(splitLinesKeepEnds(text)).toEqual(['a\r\n', 'b\n', '\n', 'c']);
    expect(splitLinesKeepEnds(text).join('')).toBe(text);
  });
});

describe('threeWayMerge', () => {
  const base = 'one\ntwo\nthree\nfour\n';
  it('merges non-overlapping edits', () => {
    const result = threeWayMerge(base, 'ONE\ntwo\nthree\nfour\n', 'one\ntwo\nthree\nFOUR\n');
    expect(result).toEqual({ clean: true, text: 'ONE\ntwo\nthree\nFOUR\n' });
  });
  it('treats identical changes as clean', () => {
    const changed = 'one\n2\nthree\nfour\n';
    expect(threeWayMerge(base, changed, changed)).toEqual({ clean: true, text: changed });
  });
  it('reports conflicts with both sides preserved', () => {
    const result = threeWayMerge(base, 'one\nours\nthree\nfour\n', 'one\ntheirs\nthree\nfour\n');
    expect(result.clean).toBe(false);
    if (!result.clean) {
      const conflict = result.regions.find((r) => 'conflict' in r);
      expect(conflict).toEqual({ conflict: { base: 'two\n', ours: 'ours\n', theirs: 'theirs\n' } });
    }
  });
  it('preserves CRLF in merged output', () => {
    const b = 'a\r\nb\r\nc\r\n';
    const result = threeWayMerge(b, 'A\r\nb\r\nc\r\n', 'a\r\nb\r\nC\r\n');
    expect(result).toEqual({ clean: true, text: 'A\r\nb\r\nC\r\n' });
  });
});

describe('names', () => {
  it('folds case, normalization and ё', () => {
    expect(foldKey('Ёлка')).toBe(foldKey('елка'));
    expect(foldKey('é')).toBe(foldKey('é'));
    expect(foldKey('README')).toBe('readme');
  });
  it('sorts numerically and per locale', () => {
    const names = ['файл 10', 'Файл 2', 'apple', 'Banana'];
    // ICU orders the locale's own script first.
    expect([...names].sort((a, b) => compareNames(a, b, 'ru'))).toEqual(['Файл 2', 'файл 10', 'apple', 'Banana']);
    expect([...names].sort((a, b) => compareNames(a, b, 'en'))).toEqual(['apple', 'Banana', 'Файл 2', 'файл 10']);
  });
  it('derives a title from the first heading or filename', () => {
    expect(deriveTitle('text\n## Заметки ##\n')).toBe('Заметки');
    expect(deriveTitle('no heading', 'notes.md')).toBe('notes');
  });
});
