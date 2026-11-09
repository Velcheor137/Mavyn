import { Library, MemoryBackend } from '@mdr/storage';
import { describe, expect, it } from 'vitest';
import { backoffDelay, operationId, SyncEngine, type SyncConnection, type SyncState } from './engine.ts';
import { FakeServer } from './fake-server.ts';

async function device(server: FakeServer, name: string) {
  const library = new Library(new MemoryBackend());
  const folder = await library.createFolder('Shared');
  let connection: SyncConnection = {
    serverId: 'https://notes.example|user',
    baseUrl: 'https://notes.example',
    userId: 'user',
    username: 'tester',
    libraryId: server.libraryId,
    libraryName: 'Shared',
    folderId: folder.id,
    cursor: '',
  };
  const states: SyncState[] = [];
  const reloaded: string[] = [];
  const engine = new SyncEngine(library, server.client(), connection, {
    saveConnection: async (c) => {
      connection = c;
    },
    onState: (s) => states.push(s),
    onRemoteChange: (ids) => reloaded.push(...ids),
    random: () => 0,
  });
  const text = async (id: string) => (await library.readContent(id)).text;
  const edit = async (id: string, next: string) => {
    const { version } = await library.readContent(id);
    await library.saveContent(id, next, version);
  };
  return { name, library, folder, engine, states, reloaded, text, edit, get connection() { return connection; } };
}

describe('SyncEngine', () => {
  it.each(['mine', 'server', 'both'] as const)('drains %s conflict resolution before retirement and never restarts the old identity', async (resolution) => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const doc = await a.library.createDocument({ text: 'base', fileName: 'retire.md', folderId: a.folder.id });
    await a.engine.syncNow();
    await a.edit(doc.id, 'mine');
    await server.edit(doc.id, 'theirs');
    await a.engine.syncNow();
    expect((await a.library.getDocument(doc.id)).remote?.conflict).not.toBeNull();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const api = server.client();
    let calls = 0;
    const engine = new SyncEngine(a.library, { ...api, getDocument: async (id) => {
      calls++; started(); await gate; return api.getDocument(id);
    } }, a.connection, { saveConnection: async () => {} });
    const work = resolution === 'mine' ? engine.keepMine(doc.id) : resolution === 'server' ? engine.useServer(doc.id) : engine.keepBoth(doc.id, 'copy');
    await entered;
    let retired = false;
    const stop = engine.stopAndWait().then(() => { retired = true; });
    try {
      await Promise.resolve(); await Promise.resolve();
      expect(retired).toBe(false);
    } finally { release(); await Promise.all([work, stop]); }
    await a.library.updateMeta(doc.id, { remote: null });
    const before = calls;
    await engine.syncNow();
    expect(calls).toBe(before);
    expect((await a.library.getDocument(doc.id)).remote).toBeNull();
  });
  it('uploads local documents in the synced folder and pulls them on another device', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const doc = await a.library.createDocument({ text: '# Привет\n\n- [ ] задача\n', fileName: 'hello.md', folderId: a.folder.id });
    await a.library.createDocument({ text: 'not synced', fileName: 'local.md' });

    await a.engine.syncNow();
    expect(a.engine.current.kind).toBe('synced');
    expect(server.docs.size).toBe(1);
    expect(server.docs.get(doc.id)?.content).toBe('# Привет\n\n- [ ] задача\n');

    await b.engine.syncNow();
    const pulled = await b.library.getDocument(doc.id);
    expect(pulled.folderId).toBe(b.folder.id);
    expect(await b.text(doc.id)).toBe('# Привет\n\n- [ ] задача\n');
    expect(b.connection.cursor).not.toBe('');
  });

  it('preserves a local move made while the initial upload is in flight and keeps syncing', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const destination = await a.library.createFolder('Elsewhere');
    const doc = await a.library.createDocument({ text: 'first', fileName: 'move.md', folderId: a.folder.id });
    const api = server.client();
    let release!: () => void;
    let signalStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const refreshed: string[] = [];
    const engine = new SyncEngine(a.library, {
      ...api,
      createDocument: async (...args) => {
        const result = await api.createDocument(...args);
        signalStarted();
        await gate;
        return result;
      },
    }, a.connection, { saveConnection: async () => {}, onRemoteChange: (ids) => refreshed.push(...ids), random: () => 0 });
    const syncing = engine.syncNow();
    await started;
    await a.library.updateMeta(doc.id, { folderId: destination.id });
    release();
    await syncing;
    expect((await a.library.getDocument(doc.id)).folderId).toBe(destination.id);
    expect(refreshed).toContain(doc.id);
    expect((await a.library.getDocument(doc.id)).remote?.baseRevisionId).toBe(server.docs.get(doc.id)?.head_revision_id);
    await a.edit(doc.id, 'second');
    await engine.syncNow();
    expect(server.docs.get(doc.id)?.content).toBe('second');
    expect((await a.library.getDocument(doc.id)).folderId).toBe(destination.id);
    engine.stop();
  });

  it('fast-forwards unmodified copies and pushes local edits', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const doc = await a.library.createDocument({ text: 'v1\n', fileName: 'n.md', folderId: a.folder.id });
    await a.engine.syncNow();
    await b.engine.syncNow();

    await b.edit(doc.id, 'v2\n');
    await b.engine.syncNow();
    expect(server.docs.get(doc.id)?.content).toBe('v2\n');
    await a.engine.syncNow();
    expect(await a.text(doc.id)).toBe('v2\n');
    expect(a.reloaded).toContain(doc.id);
    expect((await a.library.listRevisions(doc.id)).map((r) => r.reason)).toContain('sync');
  });

  it('merges non-overlapping concurrent edits on both devices', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const doc = await a.library.createDocument({ text: '- [ ] one\n- [ ] two\n- [ ] three\n', fileName: 't.md', folderId: a.folder.id });
    await a.engine.syncNow();
    await b.engine.syncNow();

    await a.edit(doc.id, '- [x] one\n- [ ] two\n- [ ] three\n');
    await b.edit(doc.id, '- [ ] one\n- [ ] two\n- [x] three\n');
    await a.engine.syncNow();
    await b.engine.syncNow(); // conflict on upload → merge → re-upload
    await a.engine.syncNow();

    const merged = '- [x] one\n- [ ] two\n- [x] three\n';
    expect(server.docs.get(doc.id)?.content).toBe(merged);
    expect(await a.text(doc.id)).toBe(merged);
    expect(await b.text(doc.id)).toBe(merged);
    expect(a.engine.current.kind).toBe('synced');
    expect(b.engine.current.kind).toBe('synced');
  });

  it('flags overlapping edits as a conflict and never overwrites either side', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const doc = await a.library.createDocument({ text: 'title\nline\n', fileName: 'c.md', folderId: a.folder.id });
    await a.engine.syncNow();
    await b.engine.syncNow();

    await a.edit(doc.id, 'title\nA version\n');
    await b.edit(doc.id, 'title\nB version\n');
    await a.engine.syncNow();
    await b.engine.syncNow();

    expect(b.engine.current).toEqual({ kind: 'conflict', count: 1 });
    expect(server.docs.get(doc.id)?.content).toBe('title\nA version\n');
    expect(await b.text(doc.id)).toBe('title\nB version\n');
    // Further syncs keep the conflict instead of uploading.
    await b.engine.syncNow();
    expect(server.docs.get(doc.id)?.content).toBe('title\nA version\n');
    expect(await b.engine.serverText(doc.id)).toBe('title\nA version\n');
    return { server, a, b, doc };
  });

  it('resolves conflicts: keep mine, use server, keep both', async () => {
    for (const resolution of ['mine', 'server', 'both'] as const) {
      const server = new FakeServer();
      const a = await device(server, 'a');
      const b = await device(server, 'b');
      const doc = await a.library.createDocument({ text: 'x\n', fileName: 'c.md', folderId: a.folder.id });
      await a.engine.syncNow();
      await b.engine.syncNow();
      await a.edit(doc.id, 'from A\n');
      await b.edit(doc.id, 'from B\n');
      await a.engine.syncNow();
      await b.engine.syncNow();

      if (resolution === 'mine') {
        await b.engine.keepMine(doc.id);
        expect(server.docs.get(doc.id)?.content).toBe('from B\n');
      } else if (resolution === 'server') {
        await b.engine.useServer(doc.id);
        expect(await b.text(doc.id)).toBe('from A\n');
        // The discarded local text is still in local history.
        const history = await b.library.listRevisions(doc.id);
        const texts = await Promise.all(history.map((r) => b.library.readRevision(r.id)));
        expect(texts).toContain('from B\n');
      } else {
        const copyId = await b.engine.keepBoth(doc.id, 'my version');
        expect(await b.text(doc.id)).toBe('from A\n');
        expect(await b.text(copyId)).toBe('from B\n');
        expect((await b.library.getDocument(copyId)).remote ?? null).toBeNull();
      }
      expect(b.engine.current.kind).toBe('synced');
    }
  });

  it('propagates deletions and keeps locally modified copies of remotely deleted documents', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const clean = await a.library.createDocument({ text: 'clean', fileName: 'a.md', folderId: a.folder.id });
    const dirty = await a.library.createDocument({ text: 'dirty', fileName: 'b.md', folderId: a.folder.id });
    await a.engine.syncNow();
    await b.engine.syncNow();

    await b.edit(dirty.id, 'dirty, edited offline');
    await a.library.trash(clean.id);
    await a.library.trash(dirty.id);
    await a.engine.syncNow();
    expect(server.docs.get(clean.id)?.deleted_at).toBeTruthy();

    await b.engine.syncNow();
    expect((await b.library.getDocument(clean.id)).deletedAt).not.toBeNull();
    const kept = await b.library.getDocument(dirty.id);
    expect(kept.deletedAt).toBeNull();
    expect(kept.remote ?? null).toBeNull();
    expect(kept.folderId).toBeNull();
    expect(await b.text(dirty.id)).toBe('dirty, edited offline');
    // The kept copy is not re-uploaded.
    await b.engine.syncNow();
    expect(server.docs.get(dirty.id)?.deleted_at).toBeTruthy();
  });

  it('retries after a lost response without duplicating revisions', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const doc = await a.library.createDocument({ text: 'one', fileName: 'a.md', folderId: a.folder.id });
    await a.engine.syncNow();
    await a.edit(doc.id, 'two');

    server.dropResponseOf = 'updateContent'; // The server applies the update, the client never hears back.
    await a.engine.syncNow();
    expect(a.engine.current.kind).toBe('offline');
    expect(server.docs.get(doc.id)?.revisions).toBe(2);

    await a.engine.syncNow();
    expect(a.engine.current.kind).toBe('synced');
    expect(server.docs.get(doc.id)?.revisions).toBe(2);
    expect(server.docs.get(doc.id)?.content).toBe('two');
    a.engine.stop();
  });

  it('retries a lost create response without creating a second document', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const doc = await a.library.createDocument({ text: 'new', fileName: 'n.md', folderId: a.folder.id });
    server.dropResponseOf = 'createDocument';
    await a.engine.syncNow();
    expect(a.engine.current.kind).toBe('offline');
    await a.engine.syncNow();
    expect(a.engine.current.kind).toBe('synced');
    expect(server.docs.size).toBe(1);
    expect((await a.library.getDocument(doc.id)).remote?.baseRevisionId).toBe(server.docs.get(doc.id)?.head_revision_id);
    a.engine.stop();
  });

  it('keeps working offline and catches up when the server returns', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    server.offline = true;
    const doc = await a.library.createDocument({ text: 'written offline', fileName: 'o.md', folderId: a.folder.id });
    await a.engine.syncNow();
    expect(a.engine.current.kind).toBe('offline');
    expect(await a.text(doc.id)).toBe('written offline');
    server.offline = false;
    await a.engine.syncNow();
    expect(server.docs.get(doc.id)?.content).toBe('written offline');
    a.engine.stop();
  });

  it('accepts a remote edit to a locally deleted document by restoring it', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const doc = await a.library.createDocument({ text: 'v1', fileName: 'a.md', folderId: a.folder.id });
    await a.engine.syncNow();
    await a.library.trash(doc.id);
    await server.edit(doc.id, 'v2 from someone else');
    await a.engine.syncNow();
    const local = await a.library.getDocument(doc.id);
    expect(local.deletedAt).toBeNull();
    expect(await a.text(doc.id)).toBe('v2 from someone else');
    expect(server.docs.get(doc.id)?.deleted_at).toBeNull();
  });
});

describe('re-linking copies kept after signing out', () => {
  it('links identical copies and flags edited ones instead of overwriting', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const same = await a.library.createDocument({ text: 'same', fileName: 's.md', folderId: a.folder.id });
    const edited = await a.library.createDocument({ text: 'v1', fileName: 'e.md', folderId: a.folder.id });
    await a.engine.syncNow();
    a.engine.stop();

    // Sign-out that keeps copies: detach everything, keep files in the folder.
    for (const id of [same.id, edited.id]) await a.library.updateMeta(id, { remote: null });
    await a.edit(edited.id, 'v1 edited while signed out');
    await server.edit(edited.id, 'v2 from the server');

    // Reconnect with a fresh cursor (a new connection).
    const engine = new SyncEngine(a.library, server.client(), { ...a.connection, cursor: '' }, { saveConnection: async () => {}, random: () => 0 });
    await engine.syncNow();
    expect((await a.library.getDocument(same.id)).remote?.conflict).toBeNull();
    expect((await a.library.getDocument(edited.id)).remote?.conflict).not.toBeNull();
    expect(await a.text(edited.id)).toBe('v1 edited while signed out');
    expect(server.docs.get(edited.id)?.content).toBe('v2 from the server');
    expect(engine.current).toEqual({ kind: 'conflict', count: 1 });

    // Push-side adoption: a copy the pull did not see (cursor already past it).
    await a.library.updateMeta(same.id, { remote: null });
    await engine.syncNow();
    expect((await a.library.getDocument(same.id)).remote?.baseRevisionId).toBe(server.docs.get(same.id)?.head_revision_id);
    expect(server.docs.size).toBe(2);
  });
});

describe('helpers', () => {
  it('derives stable UUID-shaped operation ids', async () => {
    const id = await operationId('update', 'doc', 'base', 'hash');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await operationId('update', 'doc', 'base', 'hash')).toBe(id);
    expect(await operationId('update', 'doc', 'base', 'other')).not.toBe(id);
  });

  it('backs off exponentially with a cap', () => {
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(30, () => 1)).toBe(300_000);
    expect(backoffDelay(5, () => 0)).toBe(0);
  });
});

describe('SyncEngine folders', () => {
  const tree = async (d: Awaited<ReturnType<typeof device>>) => {
    const folders = await d.library.listFolders();
    const path = (id: string | null): string => {
      if (id === d.folder.id) return '';
      const f = folders.find((x) => x.id === id);
      return f ? `${path(f.parentId)}/${f.name}` : '?';
    };
    const docs = (await d.library.listDocuments()).map((doc) => `${path(doc.folderId)}/${doc.fileName}`);
    const dirs = folders.filter((f) => f.id !== d.folder.id).map((f) => path(f.id) + '/');
    return [...dirs, ...docs].sort();
  };

  it('mirrors nested folders and the documents in them on every device', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const work = await a.library.createFolder('Работа', a.folder.id);
    const plans = await a.library.createFolder('Планы', work.id);
    await a.library.createDocument({ text: '# Q1\n', fileName: 'q1.md', folderId: plans.id });
    await a.library.createDocument({ text: 'root', fileName: 'root.md', folderId: a.folder.id });
    await a.engine.syncNow();
    expect(a.engine.current.kind).toBe('synced');
    await b.engine.syncNow();
    expect(await tree(b)).toEqual(['/root.md', '/Работа/', '/Работа/Планы/', '/Работа/Планы/q1.md']);
    expect(b.engine.current.kind).toBe('synced');
    // Same ids everywhere.
    expect((await b.library.listFolders()).map((f) => f.id)).toContain(plans.id);
  });

  it('syncs renames and moves of folders and documents in both directions', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const one = await a.library.createFolder('One', a.folder.id);
    const two = await a.library.createFolder('Two', a.folder.id);
    const doc = await a.library.createDocument({ text: 'no heading', fileName: 'draft.md', folderId: one.id });
    await a.engine.syncNow();
    await b.engine.syncNow();

    await b.library.renameFolder(one.id, 'Первая');
    await b.library.moveFolder(two.id, one.id);
    await b.library.updateMeta(doc.id, { fileName: 'final.md', folderId: two.id });
    await b.engine.syncNow();
    expect(b.engine.current.kind).toBe('synced');
    await a.engine.syncNow();
    expect(await tree(a)).toEqual(['/Первая/', '/Первая/Two/', '/Первая/Two/final.md']);
    expect((await a.library.getDocument(doc.id)).title).toBe('final');
    expect(a.reloaded).toContain(doc.id);

    await a.library.updateMeta(doc.id, { folderId: a.folder.id });
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(await tree(b)).toEqual(['/final.md', '/Первая/', '/Первая/Two/']);
  });

  it('keeps both sides of concurrent changes to different fields, and the first upload for the same field', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const target = await a.library.createFolder('Target', a.folder.id);
    const doc = await a.library.createDocument({ text: 'x', fileName: 'x.md', folderId: a.folder.id });
    await a.engine.syncNow();
    await b.engine.syncNow();

    await a.library.updateMeta(doc.id, { fileName: 'renamed-on-a.md' });
    await b.library.updateMeta(doc.id, { folderId: target.id });
    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.engine.syncNow();
    for (const d of [a, b]) expect(await tree(d)).toEqual(['/Target/', '/Target/renamed-on-a.md']);

    await a.library.updateMeta(doc.id, { fileName: 'a.md' });
    await b.library.updateMeta(doc.id, { fileName: 'b.md' });
    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.engine.syncNow();
    for (const d of [a, b]) expect((await d.library.getDocument(doc.id)).fileName).toBe('a.md');
    for (const d of [a, b]) expect(d.engine.current.kind).toBe('synced');
  });

  it('merges a folder created on two devices before they synced', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const fromA = await a.library.createFolder('Notes', a.folder.id);
    const fromB = await b.library.createFolder('notes', b.folder.id);
    await a.library.createDocument({ text: 'a', fileName: 'a.md', folderId: fromA.id });
    await b.library.createDocument({ text: 'b', fileName: 'b.md', folderId: fromB.id });
    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.engine.syncNow();
    expect(server.folders.size).toBe(1);
    for (const d of [a, b]) expect(await tree(d)).toEqual(['/Notes/', '/Notes/a.md', '/Notes/b.md']);
    expect((await b.library.listFolders({ includeTrashed: true })).some((f) => f.id === fromB.id)).toBe(false);
  });

  it('deletes a folder everywhere but keeps documents that were modified on another device', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const old = await a.library.createFolder('Old', a.folder.id);
    const inner = await a.library.createFolder('Inner', old.id);
    const clean = await a.library.createDocument({ text: 'clean', fileName: 'clean.md', folderId: inner.id });
    const edited = await a.library.createDocument({ text: 'edited', fileName: 'edited.md', folderId: old.id });
    await a.engine.syncNow();
    await b.engine.syncNow();

    await b.edit(edited.id, 'edited on b');
    await a.library.trashFolder(old.id);
    await a.engine.syncNow();
    expect([...server.folders.values()].every((f) => f.deleted_at)).toBe(true);
    await b.engine.syncNow();
    expect(await b.library.listFolders()).toEqual([expect.objectContaining({ id: b.folder.id })]);
    expect((await b.library.getDocument(clean.id)).deletedAt).not.toBeNull();
    const kept = await b.library.getDocument(edited.id);
    expect(kept.deletedAt).toBeNull();
    expect(kept.folderId).toBeNull();
    expect(await b.text(edited.id)).toBe('edited on b');
    expect(b.engine.current.kind).toBe('synced');
  });

  it('never creates a cycle when two devices nest two folders into each other', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const x = await a.library.createFolder('X', a.folder.id);
    const y = await a.library.createFolder('Y', a.folder.id);
    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.library.moveFolder(x.id, y.id);
    await b.library.moveFolder(y.id, x.id);
    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.engine.syncNow();
    for (const d of [a, b]) expect(await tree(d)).toEqual(['/Y/', '/Y/X/']);
  });

  it('uploads the subfolder of a copy synced before folder sync existed', async () => {
    const server = new FakeServer();
    const a = await device(server, 'a');
    const b = await device(server, 'b');
    const doc = await a.library.createDocument({ text: 'legacy', fileName: 'legacy.md', folderId: a.folder.id });
    await a.engine.syncNow();
    await b.engine.syncNow();
    // As written by the previous version: no name/location base, document organised locally.
    const sub = await a.library.createFolder('Archive', a.folder.id);
    const { baseFileName: _n, baseFolderId: _f, ...legacy } = (await a.library.getDocument(doc.id)).remote!;
    await a.library.updateMeta(doc.id, { folderId: sub.id, remote: legacy });
    for (const d of [b]) {
      const { baseFileName: _bn, baseFolderId: _bf, ...old } = (await d.library.getDocument(doc.id)).remote!;
      await d.library.updateMeta(doc.id, { remote: old });
    }
    await b.engine.syncNow();
    await a.engine.syncNow();
    await b.engine.syncNow();
    for (const d of [a, b]) expect(await tree(d)).toEqual(['/Archive/', '/Archive/legacy.md']);
  });
});
