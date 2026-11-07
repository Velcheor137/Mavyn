import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { AppError } from '@mdr/core';
import { IndexedDbBackend, Library, MemoryBackend, NativeBackend } from './index.ts';
import { migrateLegacy } from './migration.ts';
import { nativeTestBackend } from '../../../tests/native-bridge.ts';

describe.runIf(Boolean(process.env.MAVYN_STORAGE_BRIDGE))('legacy migration into real SQLite', () => {
  const opened: NativeBackend[] = [];
  const target = (beforeSend?: (request: Record<string, unknown>) => void) => { const backend = nativeTestBackend(beforeSend); opened.push(backend); return backend; };
  afterEach(() => { for (const backend of opened.splice(0)) backend.close(); });

  it('copies exact contents, history, folders and settings once while keeping the original', async () => {
    const sourceName = `native-migration-${crypto.randomUUID()}`;
    const source = await IndexedDbBackend.open(sourceName);
    const old = new Library(source);
    const folder = await old.createFolder('Проекты');
    const document = await old.createDocument({ text: '# Ёж\r\n', fileName: 'ё.md', folderId: folder.id, bom: true });
    await old.saveContent(document.id, '# Ёж\r\n\r\n- [x] a\r\n', document.contentHash);
    await old.putSetting('hello', { value: 'Привет' });
    const native = target();
    await migrateLegacy(async () => source, native);
    const next = new Library(native);
    expect((await next.readContent(document.id)).text).toBe('# Ёж\r\n\r\n- [x] a\r\n');
    expect((await next.getDocument(document.id)).bom).toBe(true);
    expect(await next.listFolders()).toEqual([folder]);
    expect(await next.listRevisions(document.id)).toHaveLength(2);
    expect(await next.getSetting('hello')).toEqual({ value: 'Привет' });
    const backup = await IndexedDbBackend.open(sourceName);
    expect((await new Library(backup).readContent(document.id)).text).toBe('# Ёж\r\n\r\n- [x] a\r\n');
    backup.close();
    await next.saveContent(document.id, 'native edit', (await next.readContent(document.id)).version);
    await migrateLegacy(async () => source, native);
    expect((await next.readContent(document.id)).text).toBe('native edit');
  });

  it('rolls back an interrupted import and supports retry without erasing the source', async () => {
    const source = new MemoryBackend();
    const old = new Library(source);
    const document = await old.createDocument({ text: 'keep me', fileName: 'keep.md' });
    let interrupted = true;
    const native = target((request) => {
      if (interrupted && request.op === 'put' && request.store === 'revisions') throw new AppError('storage.failed');
    });
    await expect(migrateLegacy(async () => source, native)).rejects.toMatchObject({ code: 'storage.failed' });
    expect(await native.legacyStatus()).toEqual({ empty: true, legacyImported: false });
    expect((await old.readContent(document.id)).text).toBe('keep me');
    interrupted = false;
    await migrateLegacy(async () => source, native);
    expect((await new Library(native).readContent(document.id)).text).toBe('keep me');
  });

  it('refuses to overwrite nonempty native data', async () => {
    const native = target();
    const library = new Library(native);
    const document = await library.createDocument({ text: 'native', fileName: 'native.md' });
    await expect(migrateLegacy(async () => new MemoryBackend(), native)).rejects.toMatchObject({ code: 'storage.migration_conflict' });
    expect((await library.readContent(document.id)).text).toBe('native');
  });
});
