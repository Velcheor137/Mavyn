import 'fake-indexeddb/auto';
import { AppError, sha256Hex } from '@mdr/core';
import { describe, expect, it } from 'vitest';
import { IndexedDbBackend, Library, MemoryBackend, SearchIndex, type Backend } from './index.ts';

let dbCounter = 0;
const backends: Array<[string, () => Promise<Backend>]> = [
  ['memory', async () => new MemoryBackend()],
  ['indexeddb', () => IndexedDbBackend.open(`test-${++dbCounter}`)],
];

for (const [name, makeBackend] of backends) {
  describe(`Library on ${name}`, () => {
    async function setup(now = { t: Date.parse('2026-01-01T00:00:00Z') }) {
      const library = new Library(await makeBackend(), { now: () => now.t, revisionIntervalMs: 60_000 });
      return { library, now };
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

    it('groups rapid saves into one revision and cuts a new one after the interval', async () => {
      const { library, now } = await setup();
      const meta = await library.createDocument({ text: 'v0', fileName: 'a.md' });
      let v = meta.contentHash;
      v = await library.saveContent(meta.id, 'v1', v);
      now.t += 10_000;
      v = await library.saveContent(meta.id, 'v2', v);
      expect((await library.listRevisions(meta.id)).map((r) => r.reason)).toEqual(['edit', 'import']);
      now.t += 61_000;
      v = await library.saveContent(meta.id, 'v3', v);
      const revisions = await library.listRevisions(meta.id);
      expect(revisions).toHaveLength(3);
      expect(await library.readRevision(revisions[1]!.id)).toBe('v2');
      expect(await library.readRevision(revisions[2]!.id)).toBe('v0');
    });

    it('restores an old revision as a new revision', async () => {
      const { library } = await setup();
      const meta = await library.createDocument({ text: 'original', fileName: 'a.md' });
      await library.saveContent(meta.id, 'changed', meta.contentHash);
      const importRev = (await library.listRevisions(meta.id)).find((r) => r.reason === 'import')!;
      await library.restoreRevision(meta.id, importRev.id);
      expect((await library.readContent(meta.id)).text).toBe('original');
      expect((await library.listRevisions(meta.id)).map((r) => r.reason)).toEqual(['restore', 'edit', 'import']);
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

  it('upgrades a version-1 IndexedDB database without losing documents', async () => {
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
    const old = new Library(await (async () => {
      v1.close();
      return IndexedDbBackend.open(name);
    })());
    const meta = await old.createDocument({ text: 'kept', fileName: 'a.md' });
    await old.putSyncBase({ documentId: meta.id, hash: 'h', text: 'kept' });
    expect((await old.readContent(meta.id)).text).toBe('kept');
  });
});
