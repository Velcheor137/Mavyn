import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { AppError, detectFileType, fileTitle, fileTypeByMime, inspectZip, isFileName, MAX_FILE_BYTES } from './index.ts';

const enc = new TextEncoder();
const zip = (entries: Record<string, string | Uint8Array>) =>
  zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v])));

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : 'not_app_error';
  }
}

describe('binary file detection', () => {
  it('recognises supported names and titles', () => {
    expect(isFileName('Отчёт.DOCX')).toBe(true);
    expect(isFileName('notes.md')).toBe(false);
    expect(fileTitle('План 2026.xlsx')).toBe('План 2026');
    expect(fileTitle('.pdf')).toBe('.pdf');
    expect(fileTypeByMime('application/pdf')?.format).toBe('pdf');
  });

  it('accepts real signatures and the identifying zip entry', () => {
    expect(detectFileType('a.docx', zip({ '[Content_Types].xml': '<x/>', 'word/document.xml': '<w/>' })).format).toBe('docx');
    expect(detectFileType('a.xlsx', zip({ 'xl/workbook.xml': '<w/>' })).format).toBe('xlsx');
    expect(detectFileType('a.ods', zip({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet', 'content.xml': '<c/>' })).format).toBe('ods');
    expect(detectFileType('a.pdf', enc.encode('%PDF-1.7\n%…')).format).toBe('pdf');
  });

  it('rejects wrong signatures, wrong packages and unknown names', () => {
    expect(code(() => detectFileType('a.pdf', zip({ 'word/document.xml': '' })))).toBe('file.unsupported');
    expect(code(() => detectFileType('a.docx', enc.encode('%PDF-1.4')))).toBe('file.unsupported');
    expect(code(() => detectFileType('a.docx', zip({ 'xl/workbook.xml': '' })))).toBe('file.unsupported');
    expect(code(() => detectFileType('a.exe', enc.encode('MZ')))).toBe('file.unsupported');
    expect(code(() => detectFileType('a.xlsx', enc.encode('PK\x03\x04garbage')))).toBe('file.unsupported');
  });

  it('rejects files over the size limit before parsing', () => {
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    expect(code(() => detectFileType('a.pdf', big))).toBe('file.too_large');
  });

  it('rejects zip bombs from the central directory without inflating', () => {
    // 64 MiB of zeros compresses to ~64 KiB: a ratio far above any real office document.
    const bomb = zip({ 'word/document.xml': new Uint8Array(64 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(code(() => inspectZip(bomb, 'docx'))).toBe('file.unsupported');
    expect(inspectZip(zip({ 'word/document.xml': 'hello world' }), 'docx').entries).toBe(1);
  });
});
