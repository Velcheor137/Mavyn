import { Library, MemoryBackend } from '@mdr/storage';
import { describe, expect, it } from 'vitest';
import { HttpSyncApi } from './api.ts';
import { SyncEngine, type SyncConnection } from './engine.ts';

/**
 * Two independent devices (own local database, own session) against a real running server:
 *   MDR_LIVE_URL=http://localhost:8090 MDR_LIVE_USER=admin MDR_LIVE_PASSWORD=… npx vitest run packages/sync-client/src/live.test.ts
 * The server must use COOKIE_SECURE=false for plain HTTP.
 */
const url = process.env.MDR_LIVE_URL;
const username = process.env.MDR_LIVE_USER ?? 'admin';
const password = process.env.MDR_LIVE_PASSWORD ?? '';

/** A per-device cookie jar: Node's fetch does not keep cookies. */
function deviceFetch(): typeof fetch {
  let cookie = '';
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(input, { ...init, headers });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return response;
  };
}

async function device(libraryName: string) {
  const api = new HttpSyncApi(url!, deviceFetch());
  const user = await api.login(username, password);
  const libraries = await api.listLibraries();
  const remote = libraries.find((l) => l.name === libraryName) ?? (await api.createLibrary(libraryName));
  const library = new Library(new MemoryBackend());
  const folder = await library.createFolder(remote.name);
  const connection: SyncConnection = {
    serverId: `${url}|${user.id}`,
    baseUrl: url!,
    userId: user.id,
    username: user.username,
    libraryId: remote.id,
    libraryName: remote.name,
    folderId: folder.id,
    cursor: '',
  };
  const engine = new SyncEngine(library, api, connection, { saveConnection: async () => {} });
  const edit = async (id: string, next: string) => {
    const { version } = await library.readContent(id);
    await library.saveContent(id, next, version);
  };
  const text = async (id: string) => (await library.readContent(id)).text;
  return { api, library, folder, engine, edit, text };
}

describe.skipIf(!url)('live sync between two devices', () => {
  it('creates, edits, merges, conflicts and deletes across devices', async () => {
    const name = `Live ${new Date().toISOString()}`;
    const phone = await device(name);
    const laptop = await device(name);

    // Created on the phone, appears on the laptop.
    const doc = await phone.library.createDocument({ text: '# Покупки\n\n- [ ] хлеб\n- [ ] молоко\n- [ ] сыр\n', fileName: 'shop.md', folderId: phone.folder.id });
    await phone.engine.syncNow();
    expect(phone.engine.current.kind).toBe('synced');
    await laptop.engine.syncNow();
    expect(await laptop.text(doc.id)).toBe('# Покупки\n\n- [ ] хлеб\n- [ ] молоко\n- [ ] сыр\n');
    expect((await laptop.library.getDocument(doc.id)).folderId).toBe(laptop.folder.id);

    // Different lines edited on both while "offline", then both sync: merged everywhere.
    await phone.edit(doc.id, '# Покупки\n\n- [x] хлеб\n- [ ] молоко\n- [ ] сыр\n');
    await laptop.edit(doc.id, '# Покупки\n\n- [ ] хлеб\n- [ ] молоко\n- [x] сыр\n');
    await phone.engine.syncNow();
    await laptop.engine.syncNow();
    await phone.engine.syncNow();
    const merged = '# Покупки\n\n- [x] хлеб\n- [ ] молоко\n- [x] сыр\n';
    expect(await phone.text(doc.id)).toBe(merged);
    expect(await laptop.text(doc.id)).toBe(merged);
    expect((await phone.api.getDocument(doc.id)).content).toBe(merged);

    // Same line on both: conflict on the second device, server keeps the first.
    await phone.edit(doc.id, merged.replace('- [ ] молоко', '- [ ] молоко 2 л'));
    await laptop.edit(doc.id, merged.replace('- [ ] молоко', '- [x] молоко'));
    await phone.engine.syncNow();
    await laptop.engine.syncNow();
    expect(laptop.engine.current).toEqual({ kind: 'conflict', count: 1 });
    expect((await laptop.api.getDocument(doc.id)).content).toContain('молоко 2 л');
    await laptop.engine.keepMine(doc.id);
    await phone.engine.syncNow();
    expect(await phone.text(doc.id)).toContain('- [x] молоко');

    // A document made on the laptop and deleted on the phone disappears from the laptop.
    const note = await laptop.library.createDocument({ text: 'temporary', fileName: 'tmp.md', folderId: laptop.folder.id });
    await laptop.engine.syncNow();
    await phone.engine.syncNow();
    await phone.library.trash(note.id);
    await phone.engine.syncNow();
    await laptop.engine.syncNow();
    expect((await laptop.library.getDocument(note.id)).deletedAt).not.toBeNull();

    // Subfolders, renames and moves are mirrored too.
    const work = await phone.library.createFolder('Работа', phone.folder.id);
    const plans = await phone.library.createFolder('Планы', work.id);
    const plan = await phone.library.createDocument({ text: 'без заголовка', fileName: 'план.md', folderId: plans.id });
    await phone.engine.syncNow();
    await laptop.engine.syncNow();
    expect((await laptop.library.getDocument(plan.id)).folderId).toBe(plans.id);
    expect((await laptop.library.listFolders()).find((f) => f.id === plans.id)?.parentId).toBe(work.id);
    await laptop.library.renameFolder(work.id, 'Работа 2026');
    await laptop.library.moveFolder(plans.id, laptop.folder.id);
    await laptop.library.updateMeta(plan.id, { fileName: 'итоги.md', folderId: work.id });
    await laptop.engine.syncNow();
    await phone.engine.syncNow();
    const folders = await phone.library.listFolders();
    expect(folders.find((f) => f.id === work.id)?.name).toBe('Работа 2026');
    expect(folders.find((f) => f.id === plans.id)?.parentId).toBe(phone.folder.id);
    expect(await phone.library.getDocument(plan.id)).toMatchObject({ fileName: 'итоги.md', title: 'итоги', folderId: work.id });
    await phone.library.trashFolder(work.id);
    await phone.engine.syncNow();
    await laptop.engine.syncNow();
    expect((await laptop.library.listFolders()).some((f) => f.id === work.id)).toBe(false);
    expect((await laptop.library.getDocument(plan.id)).deletedAt).not.toBeNull();

    for (const d of [phone, laptop]) {
      expect(d.engine.current.kind).toBe('synced');
      d.engine.stop();
    }
  }, 60_000);
});
