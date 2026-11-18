import { describe, expect, it } from 'vitest';
import { canonicalEncoding, decodeAs, detectText, encodeText } from './encoding.ts';
import { deriveTitle, textFormat } from './normalize.ts';

const cyrillic = 'Привет, ёжик! Список задач: молоко, хлеб.\r\nВторая строка с ЁЖИКОМ и цифрами 123.\r\n'.repeat(20);

describe('text encodings', () => {
  it('detects UTF-8 with and without BOM and writes the same bytes back', () => {
    const plain = new TextEncoder().encode(cyrillic);
    expect(detectText(plain)).toEqual({ text: cyrillic, encoding: 'utf-8', bom: false });
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...plain]);
    const decoded = detectText(withBom);
    expect(decoded).toMatchObject({ text: cyrillic, encoding: 'utf-8', bom: true });
    expect(encodeText(decoded.text, decoded.encoding, decoded.bom)).toEqual(withBom);
  });

  it('round-trips UTF-16 LE and BE with BOM', () => {
    for (const [encoding, bom] of [['utf-16le', [0xff, 0xfe]], ['utf-16be', [0xfe, 0xff]]] as const) {
      const bytes = encodeText('Ёж 🦔\n', encoding, true);
      expect([...bytes.subarray(0, 2)]).toEqual(bom);
      const decoded = detectText(bytes);
      expect(decoded).toEqual({ text: 'Ёж 🦔\n', encoding, bom: true });
    }
  });

  it('detects windows-1251 and koi8-r Russian text and writes it back byte for byte', () => {
    for (const encoding of ['windows-1251', 'koi8-r']) {
      const bytes = encodeText(cyrillic, encoding);
      const decoded = detectText(bytes);
      expect(decoded.text).toBe(cyrillic);
      expect(decoded.encoding).toBe(encoding);
      expect(encodeText(decoded.text, decoded.encoding, decoded.bom)).toEqual(bytes);
    }
  });

  it('writes two-byte CJK encodings', () => {
    const text = '日本語のテキスト、カタカナ ｶﾀｶﾅ\n';
    const bytes = encodeText(text, 'shift_jis');
    expect(decodeAs(bytes, 'shift_jis').text).toBe(text);
    expect(decodeAs(encodeText('한국어 텍스트\n', 'euc-kr'), 'euc-kr').text).toBe('한국어 텍스트\n');
  });

  it('refuses to save characters the encoding cannot represent', () => {
    expect(() => encodeText('Ёж 🦔', 'windows-1251')).toThrow(expect.objectContaining({ code: 'file.unencodable', details: expect.objectContaining({ offset: 3 }) }));
  });

  it('treats NUL bytes as binary and keeps almost-UTF-8 lossless', () => {
    expect(() => detectText(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1]))).toThrow(expect.objectContaining({ code: 'file.unsupported' }));
    const broken = new Uint8Array([...new TextEncoder().encode('log line ok\n'.repeat(50)), 0xff, 0x0a]);
    const decoded = detectText(broken);
    expect(encodeText(decoded.text, decoded.encoding, decoded.bom)).toEqual(broken);
  });

  it('canonicalizes labels and rejects undecodable ones', () => {
    expect(canonicalEncoding('latin1')).toBe('windows-1252');
    expect(canonicalEncoding('CP1251')).toBe('windows-1251');
    expect(canonicalEncoding('iso-2022-kr')).toBeNull();
    expect(canonicalEncoding('nope')).toBeNull();
  });
});

describe('text formats and titles', () => {
  it('shows Markdown by extension and everything else as plain text', () => {
    expect(textFormat('notes.md')).toBe('markdown');
    expect(textFormat('README.MDX')).toBe('markdown');
    expect(textFormat('main.py')).toBe('plain');
    expect(textFormat('notes.txt')).toBe('plain');
    expect(textFormat('Dockerfile')).toBe('plain');
  });

  it('titles code by its file name, not by comment lines', () => {
    expect(deriveTitle('# comment\nprint(1)\n', 'main.py')).toBe('main.py');
    expect(deriveTitle('# Heading\n', 'notes.md')).toBe('Heading');
    expect(deriveTitle('no heading', 'notes.markdown')).toBe('notes');
  });
});
