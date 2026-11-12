import { decodeUtf8, toAppError, type DocumentMeta } from '@mdr/core';
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
  const decoded = decodeUtf8(file.bytes);
  const source = !file.importId && file.locator && file.fingerprint
    ? { kind: 'linked' as const, locator: file.locator, fingerprint: file.fingerprint } : undefined;
  return library.createDocument({ text: decoded.text, bom: decoded.bom, fileName: file.name, folderId: placement.folderId, tags: placement.tags,
    ...(source ? { source } : {}), ...(file.importId ? { id: file.importId } : {}) });
}
