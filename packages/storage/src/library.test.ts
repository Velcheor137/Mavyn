import 'fake-indexeddb/auto';
import { AppError, sha256Hex } from '@mdr/core';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbBackend, Library, MemoryBackend, SearchIndex, type Backend } from './index.ts';
import { nativeTestBackend } from '../../../tests/native-bridge.ts';

let dbCounter = 0;
const backends: Array<[string, () => Promise<Backend>]> = [
  ['memory', async () => new MemoryBackend()],
  ['indexeddb', () => IndexedDbBackend.open(`test-${++dbCounter}`)],
];
if (process.env.MAVYN_STORAGE_BRIDGE) backends.push(['sqlite-rust', async () => nativeTestBackend()]);

for (const [name, makeBackend] of backends) {
  describe(`Library on ${name}`, () => {
    const opened: Backend[] = [];
    afterEach(() => { for (const backend of opened.splice(0)) backend.close(); });
    async function setup(now = { t: Date.parse('2026-01-01T00:00:00Z') }) {
      const backend = await makeBackend();
      opened.push(backend);
      const library = new Library(backend, { now: () => now.t });
      return { library, now, backend };
    }

    it('creates, reads and saves with compare-and-swap', async () => {
      const { library } = await setup();
      const meta = await library.createDocument({ text: '# Привет\n\n- [ ] a\n', fileName: 'hello.md', tags: ['#Work', 'work', 'Дом'] });
      expect(meta.title).toBe('Привет');
      expect(meta.tags).toEqual(['Work', 'Дом']);
      const { text, version } = await library.readContent(meta.id);
      expect(version).toBe(await sha256Hex(text));

      const v2 = await library.saveContent(meta.id, '# Привет\n\n- [x] a\n', version);
      expect((await library.readContent(meta.id)).text).toContain('[x]');
      await expect(library.saveContent(meta.id, 'stale write', version)).rejects.toMatchObject({ code: 'file.external_change' });
      expect((await library.readContent(meta.id)).version).toBe(v2);
    });

    it('keeps only the current text and drops replaced content unless another document shares it', async () => {
      const { library, backend } = await setup();
      const contents = () => backend.transaction(['contents'], 'readonly', (tx) => tx.getAll<{ hash: string; text: string }>('contents'));
      const meta = await library.createDocument({ text: 'v0', fileName: 'a.md' });
      const twin = await library.createDocument({ text: 'v0', fileName: 'b.md' });
      let v = await library.saveContent(meta.id, 'v1', meta.contentHash);
      // 'v0' stays: the twin still uses it.
      expect((await contents()).map((c) => c.text).sort()).toEqual(['v0', 'v1']);
      v = await library.saveContent(meta.id, 'v2', v);
      expect((await contents()).map((c) => c.text).sort()).toEqual(['v0', 'v2']);
      expect((await library.readContent(meta.id)).version).toBe(v);
      expect((await library.readContent(twin.id)).text).toBe('v0');
      expect(meta).not.toHaveProperty('headRevisionId');
    });

    it('trashes, restores and purges', async () => {
      const { library } = await setup();
      const meta = await library.createDocument({ text: 'bye', fileName: 'a.md' });
      await expect(library.purge(meta.id)).rejects.toBeInstanceOf(AppError);
      await library.trash(meta.id);
      expect(await library.listDocuments()).toHaveLength(0);
      await library.restore(meta.id);
      expect(await library.listDocuments()).toHaveLength(1);
      await library.trash(meta.id);
      await library.purge(meta.id);
      expect(await library.listDocuments({ includeTrashed: true })).toHaveLength(0);
      await expect(library.readContent(meta.id)).rejects.toMatchObject({ code: 'document.not_found' });
    });

    it('keeps deduplicated content shared by another document when purging', async () => {
      const { library } = await setup();
      const a = await library.createDocument({ text: 'same', fileName: 'a.md' });
      const b = await library.createDocument({ text: 'same', fileName: 'b.md' });
      await library.trash(a.id);
      await library.purge(a.id);
      expect((await library.readContent(b.id)).text).toBe('same');
    });

    it('manages folders without cycles or duplicate names', async () => {
      const { library } = await setup();
      const root = await library.createFolder('Проекты');
      const child = await library.createFolder('2026', root.id);
      await expect(library.createFolder('проекты')).rejects.toBeInstanceOf(AppError);
      await expect(library.moveFolder(root.id, child.id)).rejects.toMatchObject({ details: { reason: 'folder_cycle' } });
      const doc = await library.createDocument({ text: 'x', fileName: 'x.md', folderId: child.id });
      await library.trashFolder(root.id);
      expect(await library.listFolders()).toHaveLength(0);
      expect((await library.getDocument(doc.id)).deletedAt).not.toBeNull();
    });

    it('rejects blank and duplicate names when renaming folders', async () => {
      const { library } = await setup();
      const first = await library.createFolder('Проекты');
      const second = await library.createFolder('Other');
      await expect(library.renameFolder(second.id, '  ')).rejects.toMatchObject({ code: 'folder.invalid_name' });
      await expect(library.renameFolder(second.id, ' проекты ')).rejects.toMatchObject({ code: 'folder.duplicate_name' });
      expect((await library.listFolders()).find((f) => f.id === second.id)?.name).toBe('Other');
      await library.renameFolder(first.id, ' Проекты ');
      expect((await library.listFolders()).find((f) => f.id === first.id)?.name).toBe('Проекты');
    });

    it('rejects duplicate sibling names on move and preserves the source parent', async () => {
      const { library } = await setup();
      const root = await library.createFolder('Root');
      await library.createFolder('Café', root.id);
      const moving = await library.createFolder('Cafe\u0301');
      await expect(library.moveFolder(moving.id, root.id)).rejects.toMatchObject({ code: 'folder.duplicate_name' });
      expect((await library.listFolders()).find((f) => f.id === moving.id)?.parentId).toBeNull();
    });

    it('rejects missing and trashed folder destinations for folders and documents', async () => {
      const { library } = await setup();
      const moving = await library.createFolder('Keep');
      const deleted = await library.createFolder('Deleted');
      await library.trashFolder(deleted.id);
      const doc = await library.createDocument({ text: 'unchanged', fileName: 'keep.md' });
      for (const parentId of ['missing', deleted.id]) {
        await expect(library.createFolder('New', parentId)).rejects.toMatchObject({ code: 'folder.not_found' });
        await expect(library.moveFolder(moving.id, parentId)).rejects.toMatchObject({ code: 'folder.not_found' });
        await expect(library.createDocument({ text: 'orphan', fileName: 'orphan.md', folderId: parentId })).rejects.toMatchObject({ code: 'folder.not_found' });
        await expect(library.updateMeta(doc.id, { folderId: parentId })).rejects.toMatchObject({ code: 'folder.not_found' });
      }
      expect(await library.listDocuments()).toHaveLength(1);
      expect((await library.getDocument(doc.id)).folderId).toBeNull();
      expect((await library.readContent(doc.id)).text).toBe('unchanged');
      expect(await library.listFolders()).toHaveLength(1);
    });

    it('moves folders and documents without rewriting content, history or remote refs', async () => {
      const { library } = await setup();
      const a = await library.createFolder('A');
      const b = await library.createFolder('B');
      const child = await library.createFolder('Child', a.id);
      const remote = { serverId: 'server', libraryId: 'remote', baseRevisionId: 'r', baseHash: 'h', conflict: null };
      const doc = await library.createDocument({ text: 'keep\r\n', fileName: 'keep.md', folderId: child.id, remote });
      await library.moveFolder(child.id, b.id);
      await library.updateMeta(doc.id, { folderId: b.id });
      expect((await library.listFolders()).find((f) => f.id === child.id)?.parentId).toBe(b.id);
      expect((await library.getDocument(doc.id)).remote).toEqual(remote);
      expect((await library.readContent(doc.id)).text).toBe('keep\r\n');
      await library.updateMeta(doc.id, { folderId: null });
      expect((await library.getDocument(doc.id)).folderId).toBeNull();
    });

    it('searches Russian and English with folding and prefixes', async () => {
      const { library } = await setup();
      const ru = await library.createDocument({ text: '# Ёжик\n\nСписок задач на неделю', fileName: 'ru.md' });
      const en = await library.createDocument({ text: '# Groceries\n\nBuy MILK and bread', fileName: 'en.md' });
      await library.createDocument({ text: 'Mixed: задачи and tasks', fileName: 'mix.md' });
      expect((await library.search('ежик')).map((h) => h.documentId)).toEqual([ru.id]);
      expect((await library.search('задач')).length).toBe(2);
      expect((await library.search('milk')).map((h) => h.documentId)).toEqual([en.id]);
      const [hit] = await library.search('задач tasks');
      expect(hit?.snippet).toContain('задачи');
      expect(hit?.ranges.length).toBeGreaterThan(0);
      await library.trash(ru.id);
      expect((await library.search('ежик'))).toEqual([]);
    });

    it('lists tags with counts in locale order', async () => {
      const { library } = await setup();
      await library.createDocument({ text: 'a', fileName: 'a.md', tags: ['работа', 'alpha'] });
      await library.createDocument({ text: 'b', fileName: 'b.md', tags: ['Работа'] });
      expect(await library.listTags('ru')).toEqual([{ tag: 'работа', count: 2 }, { tag: 'alpha', count: 1 }]);
    });

    it('stores binary documents with name-only search', async () => {
      const { library } = await setup();
      const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) & 255);
      bytes.set(new TextEncoder().encode('%PDF-1.7'));
      const meta = await library.createFileDocument({ bytes, fileName: 'Квартальный отчёт.pdf', mime: 'application/pdf', tags: ['Работа'] });
      expect(meta).toMatchObject({ kind: 'file', mime: 'application/pdf', title: 'Квартальный отчёт', bom: false, source: { kind: 'imported' } });
      expect(meta.contentHash).toBe(await sha256Hex(bytes));

      const read = await library.readFile(meta.id);
      expect(read.bytes).toEqual(bytes);
      await expect(library.readContent(meta.id)).rejects.toMatchObject({ code: 'document.not_text' });
      await expect(library.saveContent(meta.id, 'text', meta.contentHash)).rejects.toMatchObject({ code: 'document.not_text' });
      await expect(library.createFileDocument({ bytes, fileName: 'x.exe', mime: 'application/x-msdownload' })).rejects.toMatchObject({ code: 'file.unsupported' });

      const text = await library.createDocument({ text: 'отчёт в тексте', fileName: 'a.md' });
      await expect(library.readFile(text.id)).rejects.toMatchObject({ code: 'document.not_file' });

      expect((await library.search('квартальн')).map((h) => h.documentId)).toEqual([meta.id]);
      const renamed = await library.updateMeta(meta.id, { fileName: 'Годовой.pdf' });
      expect(renamed.title).toBe('Годовой');
      expect((await library.search('годовой')).map((h) => h.documentId)).toEqual([meta.id]);
      // The type's extension is kept so the copy still opens as a PDF everywhere.
      expect((await library.updateMeta(meta.id, { fileName: 'Без расширения' })).fileName).toBe('Без расширения.pdf');
      expect((await library.updateMeta(meta.id, { fileName: 'Годовой.pdf' })).fileName).toBe('Годовой.pdf');

      await library.trash(meta.id);
      await library.restore(meta.id);
      expect((await library.search('годовой')).map((h) => h.documentId)).toEqual([meta.id]);
    });

    it('shares identical file bytes and purges them with the last document', async () => {
      const { library } = await setup();
      const bytes = new TextEncoder().encode('%PDF-1.4 same bytes');
      const a = await library.createFileDocument({ bytes, fileName: 'a.pdf', mime: 'application/pdf' });
      const b = await library.createFileDocument({ bytes, fileName: 'b.pdf', mime: 'application/pdf' });
      await library.trash(a.id);
      await library.purge(a.id);
      expect((await library.readFile(b.id)).bytes).toEqual(bytes);
      await library.trash(b.id);
      await library.purge(b.id);
      await expect(library.readFile(b.id)).rejects.toMatchObject({ code: 'document.not_found' });
    });
  });
}

describe('SearchIndex', () => {
  it('highlights correct ranges in snippets', () => {
    const index = new SearchIndex();
    index.upsert('1', 'T', 'Первая строка. Здесь важное СЛОВО внутри.');
    const [hit] = index.search('слово');
    expect(hit).toBeDefined();
    const [from, to] = hit!.ranges[0]!;
    expect(hit!.snippet.slice(from, to)).toBe('СЛОВО');
  });
});

describe('sync support', () => {
  it('keeps ids, remote refs, sync bases and settings, and emits changes', async () => {
    const library = new Library(new MemoryBackend());
    const seen: string[][] = [];
    library.onChange((ids) => seen.push(ids));
    const remote = { serverId: 's', libraryId: 'l', baseRevisionId: 'r1', baseHash: 'h', conflict: null };
    const meta = await library.createDocument({ id: '0190f0a0-0000-7000-8000-000000000001', text: 'x', fileName: 'a.md', remote });
    expect(meta.id).toBe('0190f0a0-0000-7000-8000-000000000001');
    expect((await library.getDocument(meta.id)).remote).toEqual(remote);
    await expect(library.createDocument({ id: meta.id, text: 'y', fileName: 'b.md' })).rejects.toMatchObject({ details: { reason: 'duplicate_id' } });

    await library.putSyncBase({ documentId: meta.id, hash: 'h', text: 'x' });
    expect(await library.getSyncBase(meta.id)).toEqual({ documentId: meta.id, hash: 'h', text: 'x' });
    await library.putSetting('sync', { a: 1 });
    expect(await library.getSetting('sync')).toEqual({ a: 1 });
    await library.putSetting('sync', null);
    expect(await library.getSetting('sync')).toBeNull();

    await library.updateMeta(meta.id, { openedAt: new Date().toISOString() });
    await library.trash(meta.id);
    await library.purge(meta.id);
    expect(await library.getSyncBase(meta.id)).toBeNull();
    expect(seen).toEqual([[meta.id], [meta.id], [meta.id]]);
  });

  it('upgrades a version-1 IndexedDB database, dropping old history but no documents', async () => {
    const { openDB } = await import('idb');
    const name = `upgrade-${Date.now()}`;
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        for (const [store, keyPath] of [['documents', 'id'], ['contents', 'hash'], ['revisions', 'id'], ['folders', 'id'], ['handles', 'documentId'], ['settings', 'key']] as const) {
          const os = db.createObjectStore(store, { keyPath });
          if (store === 'revisions') os.createIndex('documentId', 'documentId');
        }
      },
    });
    const old = { id: 'old', libraryId: 'local', folderId: null, title: 'Old', fileName: 'old.md', source: { kind: 'imported' }, headRevisionId: 'r2', contentHash: 'now', bom: false, tags: [], favorite: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', openedAt: null, deletedAt: null };
    await v1.put('documents', old);
    await v1.put('contents', { hash: 'now', text: 'current' });
    await v1.put('contents', { hash: 'before', text: 'only in history' });
    await v1.put('revisions', { id: 'r1', documentId: 'old', contentHash: 'before' });
    v1.close();
    const backend = await IndexedDbBackend.open(name);
    const upgraded = new Library(backend);
    expect((await upgraded.readContent('old')).text).toBe('current');
    const texts = await backend.transaction(['contents'], 'readonly', (tx) => tx.getAll<{ text: string }>('contents'));
    expect(texts.map((c) => c.text)).toEqual(['current']);
    const raw = await openDB(name);
    expect([...raw.objectStoreNames]).not.toContain('revisions');
    raw.close();
    const meta = await upgraded.createDocument({ text: 'kept', fileName: 'a.md' });
    await upgraded.putSyncBase({ documentId: meta.id, hash: 'h', text: 'kept' });
    expect((await upgraded.readContent(meta.id)).text).toBe('kept');
    backend.close();
  });
});

describe('adoptLegacyLibrary', () => {
  it('moves an anonymous library into an empty account library once', async () => {
    const { adoptLegacyLibrary } = await import('./index.ts');
    const legacyBackend = new MemoryBackend();
    const legacy = new Library(legacyBackend);
    const folder = await legacy.createFolder('Notes');
    const doc = await legacy.createDocument({ text: '# Kept\n', fileName: 'kept.md', folderId: folder.id });
    const userBackend = new MemoryBackend();

    expect(await adoptLegacyLibrary(legacyBackend, userBackend)).toBe(true);
    const user = new Library(userBackend);
    expect((await user.readContent(doc.id)).text).toBe('# Kept\n');
    expect((await user.getDocument(doc.id)).folderId).toBe(folder.id);

    // A non-empty target is never merged into.
    expect(await adoptLegacyLibrary(legacyBackend, userBackend)).toBe(false);
    expect(await adoptLegacyLibrary(new MemoryBackend(), new MemoryBackend())).toBe(false);
  });
});
