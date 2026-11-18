import { unzipSync } from 'fflate';
import { AppError } from './errors.ts';

/**
 * Binary documents (docx, xlsx, ods, pdf) are view-only and immutable: their bytes are fixed at
 * import and never edited, merged or versioned. See docs/architecture.md (ADR-007).
 */
export type FileFormat = 'docx' | 'xlsx' | 'ods' | 'pdf';

export interface FileType {
  format: FileFormat;
  extension: string;
  mime: string;
}

export const FILE_TYPES: readonly FileType[] = [
  { format: 'docx', extension: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { format: 'xlsx', extension: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { format: 'ods', extension: '.ods', mime: 'application/vnd.oasis.opendocument.spreadsheet' },
  { format: 'pdf', extension: '.pdf', mime: 'application/pdf' },
];

export const FILE_EXTENSIONS: readonly string[] = FILE_TYPES.map((t) => t.extension);

/** Upper bound for one binary document on every platform and on the server. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Office files are zip archives; refuse ones that would inflate beyond this before parsing. */
export const MAX_UNZIPPED_BYTES = 300 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 20_000;
const MAX_RATIO = 200;

/** Entry that identifies each zip-based format (the rest of the package is not inspected). */
const REQUIRED_ENTRY: Partial<Record<FileFormat, string>> = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  ods: 'content.xml',
};

export function fileTypeByName(name: string): FileType | null {
  const lower = name.toLowerCase();
  return FILE_TYPES.find((t) => lower.endsWith(t.extension)) ?? null;
}

export function fileTypeByMime(mime: string | null | undefined): FileType | null {
  return FILE_TYPES.find((t) => t.mime === mime) ?? null;
}

export function isFileName(name: string): boolean {
  return fileTypeByName(name) !== null;
}

/** Title of a binary document: the file name without its extension. */
export function fileTitle(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return (dot > 0 ? fileName.slice(0, dot) : fileName).trim() || fileName;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((b, i) => bytes[at + i] === b);
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/**
 * Reads the zip central directory without inflating anything and rejects archives that are too
 * large when unpacked (zip bombs) or lack the entry that identifies `format`.
 */
export function inspectZip(bytes: Uint8Array, format?: FileFormat): { entries: number; unzippedBytes: number } {
  let entries = 0;
  let unzippedBytes = 0;
  let compressedBytes = 0;
  const names = new Set<string>();
  try {
    unzipSync(bytes, {
      filter(file) {
        entries++;
        unzippedBytes += file.originalSize;
        compressedBytes += file.size;
        names.add(file.name);
        return false;
      },
    });
  } catch (cause) {
    throw new AppError('file.unsupported', { reason: 'bad_zip' }, cause);
  }
  if (entries > MAX_ZIP_ENTRIES || unzippedBytes > MAX_UNZIPPED_BYTES || unzippedBytes > Math.max(1, compressedBytes) * MAX_RATIO) {
    throw new AppError('file.unsupported', { reason: 'zip_too_large', unzippedBytes });
  }
  const required = format ? REQUIRED_ENTRY[format] : undefined;
  if (required && !names.has(required)) throw new AppError('file.unsupported', { reason: 'wrong_format' });
  return { entries, unzippedBytes };
}

/**
 * Identifies a supported binary document by its name and verifies size and signature.
 * Throws `file.too_large` or `file.unsupported`.
 */
export function detectFileType(name: string, bytes: Uint8Array): FileType {
  const type = fileTypeByName(name);
  if (!type) throw new AppError('file.unsupported', { name });
  if (bytes.length > MAX_FILE_BYTES) throw new AppError('file.too_large', { maxBytes: MAX_FILE_BYTES });
  if (type.format === 'pdf') {
    // The header may be preceded by a little junk; readers accept it within the first 1 KiB.
    const head = bytes.subarray(0, 1024);
    let found = false;
    for (let i = 0; i + PDF_MAGIC.length <= head.length && !found; i++) found = startsWith(head, PDF_MAGIC, i);
    if (!found) throw new AppError('file.unsupported', { reason: 'wrong_format' });
  } else {
    if (!startsWith(bytes, ZIP_MAGIC)) throw new AppError('file.unsupported', { reason: 'wrong_format' });
    inspectZip(bytes, type.format);
  }
  return type;
}
