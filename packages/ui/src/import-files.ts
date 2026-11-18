import { detectFileType, detectText, isFileName, toAppError, type DocumentMeta } from '@mdr/core';
import type { PickedFile } from '@mdr/platform';
import type { Library } from '@mdr/storage';

/** Where a new document goes: the folder (and tag) the user is looking at. */
export interface Placement {
  folderId: string | null;
  tags: string[];
}

export async function importPickedFile(library: Library, file: PickedFile, placement: Placement = { folderId: null, tags: [] }): Promise<DocumentMeta> {
  if (file.importId) {
    try { return await library.getDocument(file.importId); }
    catch (error) { if (toAppError(error).code !== 'document.not_found') throw error; }
  }
  if (isFileName(file.name)) {
    const type = detectFileType(file.name, file.bytes);
    // docx/xlsx/ods can be edited in place on disk; PDF is view-only, so it is always a copy.
    const linked = type.format !== 'pdf' && !file.importId && file.locator && file.fingerprint
      ? { kind: 'linked' as const, locator: file.locator, fingerprint: file.fingerprint } : null;
    const meta = await library.createFileDocument({ bytes: file.bytes, fileName: file.name, mime: type.mime, folderId: placement.folderId, tags: placement.tags,
      ...(file.importId ? { id: file.importId } : {}) });
    return linked ? library.updateMeta(meta.id, { source: linked }) : meta;
  }
  // Any text file: the encoding is detected and remembered so saving writes the same encoding back.
  const decoded = detectText(file.bytes);
  const source = !file.importId && file.locator && file.fingerprint
    ? { kind: 'linked' as const, locator: file.locator, fingerprint: file.fingerprint } : undefined;
  // A linked file can always be re-read from disk; an imported non-UTF-8 copy keeps its bytes until
  // the first edit in case the detected encoding is wrong.
  const keepBytes = !source && decoded.encoding !== 'utf-8';
  return library.createDocument({ text: decoded.text, bom: decoded.bom, encoding: decoded.encoding, fileName: file.name, folderId: placement.folderId, tags: placement.tags,
    ...(keepBytes ? { originalBytes: file.bytes } : {}), ...(source ? { source } : {}), ...(file.importId ? { id: file.importId } : {}) });
}
