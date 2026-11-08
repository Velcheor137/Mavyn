import { describe, expect, it } from 'vitest';
import { Library, MemoryBackend } from '@mdr/storage';
import { importPickedFile } from '../packages/ui/src/import-files.ts';

describe('incoming managed imports', () => {
  it('retries the same delivery without overwriting later edits or duplicating history', async () => {
    const library = new Library(new MemoryBackend());
    const file = { name: 'received.md', bytes: new TextEncoder().encode('\ufeff# Ёж\r\n'), locator: null, fingerprint: null, importId: '019a6110-0000-7000-8000-000000000001' };
    const first = await importPickedFile(library, file);
    await library.saveContent(first.id, 'edited\r\n', first.contentHash);
    expect((await importPickedFile(library, file)).id).toBe(first.id);
    expect((await library.listDocuments())).toHaveLength(1);
    expect((await library.readContent(first.id)).text).toBe('edited\r\n');
    expect(first.bom).toBe(true);
    expect(first.source.kind).toBe('imported');
  });
});
