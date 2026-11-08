import { decodeUtf8, toAppError, type DocumentMeta } from '@mdr/core';
import type { PickedFile } from '@mdr/platform';
import type { Library } from '@mdr/storage';

export async function importPickedFile(library: Library, file: PickedFile): Promise<DocumentMeta> {
  if (file.importId) {
    try { return await library.getDocument(file.importId); }
    catch (error) { if (toAppError(error).code !== 'document.not_found') throw error; }
  }
  const decoded = decodeUtf8(file.bytes);
  const source = !file.importId && file.locator && file.fingerprint
    ? { kind: 'linked' as const, locator: file.locator, fingerprint: file.fingerprint } : undefined;
  return library.createDocument({ text: decoded.text, bom: decoded.bom, fileName: file.name,
    ...(source ? { source } : {}), ...(file.importId ? { id: file.importId } : {}) });
}
