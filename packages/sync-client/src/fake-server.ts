import { sha256Hex, uuidv7 } from '@mdr/core';
import { SyncHttpError, type SyncApi } from './api.ts';
import type {
  ChangesResponse,
  CreateDocumentRequest,
  CreateFolderRequest,
  DocumentInfo,
  DocumentWithContent,
  FolderInfo,
  LibraryInfo,
  MeResponse,
  UpdateContentRequest,
  UpdateDocumentMetaRequest,
  UpdateFolderRequest,
} from './protocol.ts';

interface StoredDoc extends DocumentInfo {
  content: string;
  seq: number;
  revisions: number;
}

interface StoredFolder extends FolderInfo {
  seq: number;
}

/**
 * In-memory implementation of the server semantics the sync engine relies on: compare-and-swap
 * content updates, idempotency keys, a sequence-ordered change feed with tombstones. Used by tests;
 * the real server is covered by `apps/server/tests/api.rs`.
 */
export class FakeServer {
  readonly docs = new Map<string, StoredDoc>();
  readonly folders = new Map<string, StoredFolder>();
  private readonly ops = new Map<string, DocumentInfo>();
  private seq = 0;
  readonly libraryId = uuidv7();
  /** The fake serves one library; a brand-new server has none until one is created. */
  libraries: LibraryInfo[] = [{ id: this.libraryId, name: 'Shared', role: 'owner' }];
  /** The next call of this operation fails as if the network dropped *after* the server applied it. */
  dropResponseOf: 'createDocument' | 'updateContent' | 'deleteDocument' | null = null;
  offline = false;
  /** When set, the server has no users yet and accepts this setup token once. */
  setupToken: string | null = null;
  /** When set, `me` answers 401 until `login` with this password succeeds (per client). */
  password: string | null = null;

  client(): SyncApi {
    const guard = async <T>(fn: () => Promise<T>, op?: FakeServer['dropResponseOf']): Promise<T> => {
      if (this.offline) throw new TypeError('Failed to fetch');
      const result = await fn();
      if (op && this.dropResponseOf === op) {
        this.dropResponseOf = null;
        throw new TypeError('Failed to fetch');
      }
      return structuredClone(result);
    };
    const me: MeResponse = { id: 'user', username: 'tester', is_admin: true, csrf_token: 'csrf' };
    let signedIn = this.password === null;
    const signIn = (username: string, password?: string) => {
      if (this.password !== null && password !== this.password) throw new SyncHttpError(401, 'auth.invalid_credentials', null);
      signedIn = true;
      me.username = username;
      return me;
    };
    return {
      needsSetup: () => guard(async () => this.setupToken !== null),
      setup: (token, username) =>
        guard(async () => {
          if (this.setupToken === null) throw new SyncHttpError(409, 'setup.already_completed', null);
          if (token !== this.setupToken) throw new SyncHttpError(403, 'setup.invalid_token', null);
          this.setupToken = null;
          return { id: me.id, username, is_admin: true };
        }),
      me: () =>
        guard(async () => {
          if (!signedIn) throw new SyncHttpError(401, 'auth.required', null);
          return me;
        }),
      login: (username, password) => guard(async () => signIn(username, password)),
      logout: () =>
        guard(async () => {
          signedIn = this.password === null;
        }),
      listLibraries: () => guard(async () => this.libraries),
      createLibrary: (name) =>
        guard(async (): Promise<LibraryInfo> => {
          const library: LibraryInfo = { id: this.libraryId, name, role: 'owner' };
          this.libraries = [library];
          return library;
        }),
      changes: (_lib, cursor) => guard(async () => this.changes(cursor)),
      getDocument: (id) => guard(async () => this.get(id)),
      createDocument: (_lib, req, opId) => guard(() => this.create(req, opId), 'createDocument'),
      updateContent: (id, req, opId) => guard(() => this.update(id, req, opId), 'updateContent'),
      updateDocumentMeta: (id, req) => guard(async () => this.updateMeta(id, req)),
      deleteDocument: (id) => guard(async () => this.remove(id), 'deleteDocument'),
      createFolder: (_lib, req) => guard(async () => this.createFolder(req)),
      updateFolder: (id, req) => guard(async () => this.updateFolder(id, req)),
      deleteFolder: (id) => guard(async () => this.deleteFolder(id)),
    };
  }

  private info(doc: StoredDoc): DocumentInfo {
    const { content: _c, seq: _s, revisions: _r, ...info } = doc;
    return info;
  }

  private changes(cursor: string): ChangesResponse {
    const after = Number(cursor || 0);
    const docs = [...this.docs.values()].filter((d) => d.seq > after).sort((a, b) => a.seq - b.seq);
    const folders = [...this.folders.values()].filter((f) => f.seq > after).sort((a, b) => a.seq - b.seq);
    return {
      documents: docs.map((d) => this.info(d)),
      folders: folders.map((f) => this.folderInfo(f)),
      cursor: String(Math.max(after, docs.at(-1)?.seq ?? 0, folders.at(-1)?.seq ?? 0)),
      has_more: false,
    };
  }

  private folderInfo(folder: StoredFolder): FolderInfo {
    const { seq: _s, ...info } = folder;
    return info;
  }

  private liveFolder(id: string | null): boolean {
    return id !== null && this.folders.get(id)?.deleted_at === null;
  }

  createFolder(req: CreateFolderRequest): FolderInfo {
    const existing = this.folders.get(req.id);
    if (existing) return this.folderInfo(existing);
    const parent = this.liveFolder(req.parent_id) ? req.parent_id : null;
    const same = [...this.folders.values()].find((f) => f.deleted_at === null && f.parent_id === parent && f.name.toLowerCase() === req.name.trim().toLowerCase());
    if (same) return this.folderInfo(same);
    const folder: StoredFolder = { id: req.id, library_id: this.libraryId, parent_id: parent, name: req.name.trim(), updated_at: new Date().toISOString(), deleted_at: null, seq: ++this.seq };
    this.folders.set(folder.id, folder);
    return this.folderInfo(folder);
  }

  updateFolder(id: string, req: UpdateFolderRequest): FolderInfo {
    const folder = this.folders.get(id);
    if (!folder || folder.deleted_at) throw new SyncHttpError(404, 'folder.not_found', null);
    const name = req.name !== req.base_name && folder.name === req.base_name ? req.name.trim() : folder.name;
    let parent = folder.parent_id;
    if (req.parent_id !== req.base_parent_id && folder.parent_id === req.base_parent_id && (req.parent_id === null || this.liveFolder(req.parent_id))) {
      let cycle = false;
      for (let cur = req.parent_id; cur !== null; cur = this.folders.get(cur)?.parent_id ?? null) if (cur === id) cycle = true;
      if (!cycle) parent = req.parent_id;
    }
    if (name !== folder.name || parent !== folder.parent_id) Object.assign(folder, { name, parent_id: parent, seq: ++this.seq, updated_at: new Date().toISOString() });
    return this.folderInfo(folder);
  }

  deleteFolder(id: string): void {
    if (!this.folders.has(id)) throw new SyncHttpError(404, 'folder.not_found', null);
    const ids = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of this.folders.values()) if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
    }
    const now = new Date().toISOString();
    for (const d of this.docs.values()) if (d.folder_id && ids.has(d.folder_id) && !d.deleted_at) Object.assign(d, { deleted_at: now, seq: ++this.seq });
    for (const f of this.folders.values()) if (ids.has(f.id) && !f.deleted_at) Object.assign(f, { deleted_at: now, seq: ++this.seq });
  }

  updateMeta(id: string, req: UpdateDocumentMetaRequest): DocumentInfo {
    const doc = this.docs.get(id);
    if (!doc || doc.deleted_at) throw new SyncHttpError(404, 'document.not_found', null);
    const fileName = req.file_name !== req.base_file_name && doc.file_name === req.base_file_name ? req.file_name : doc.file_name;
    const moveOk = req.folder_id === null || this.liveFolder(req.folder_id);
    const folderId = req.folder_id !== req.base_folder_id && doc.folder_id === req.base_folder_id && moveOk ? req.folder_id : doc.folder_id;
    if (fileName !== doc.file_name || folderId !== doc.folder_id) Object.assign(doc, { file_name: fileName, folder_id: folderId, seq: ++this.seq, updated_at: new Date().toISOString() });
    return this.info(doc);
  }

  private get(id: string): DocumentWithContent {
    const doc = this.docs.get(id);
    if (!doc || doc.deleted_at) throw new SyncHttpError(404, 'document.not_found', null);
    return { ...this.info(doc), content: doc.content };
  }

  async create(req: CreateDocumentRequest, opId: string): Promise<DocumentInfo> {
    const replay = this.ops.get(opId);
    if (replay) return replay;
    if (this.docs.has(req.id)) throw new SyncHttpError(409, 'sync.conflict', null);
    const doc: StoredDoc = {
      id: req.id,
      library_id: this.libraryId,
      folder_id: this.liveFolder(req.folder_id ?? null) ? req.folder_id! : null,
      title: req.file_name,
      file_name: req.file_name,
      head_revision_id: uuidv7(),
      content_hash: await sha256Hex(req.content),
      updated_at: new Date().toISOString(),
      deleted_at: null,
      content: req.content,
      seq: ++this.seq,
      revisions: 1,
    };
    this.docs.set(doc.id, doc);
    this.ops.set(opId, this.info(doc));
    return this.info(doc);
  }

  async update(id: string, req: UpdateContentRequest, opId: string): Promise<DocumentInfo> {
    const replay = this.ops.get(opId);
    if (replay) return replay;
    const doc = this.docs.get(id);
    if (!doc || doc.deleted_at) throw new SyncHttpError(404, 'document.not_found', null);
    if (doc.head_revision_id !== req.base_revision_id) {
      throw new SyncHttpError(409, 'sync.conflict', { head_revision_id: doc.head_revision_id, content_hash: doc.content_hash });
    }
    if ((await sha256Hex(req.content)) !== req.content_hash) throw new SyncHttpError(400, 'request.invalid', null);
    Object.assign(doc, {
      content: req.content,
      content_hash: req.content_hash,
      head_revision_id: uuidv7(),
      seq: ++this.seq,
      revisions: doc.revisions + 1,
      updated_at: new Date().toISOString(),
    });
    this.ops.set(opId, this.info(doc));
    return this.info(doc);
  }

  private remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc || doc.deleted_at) throw new SyncHttpError(404, 'document.not_found', null);
    doc.deleted_at = new Date().toISOString();
    doc.seq = ++this.seq;
  }

  /** Simulates another user editing on the server directly. */
  async edit(id: string, content: string): Promise<void> {
    const doc = this.docs.get(id)!;
    await this.update(id, { base_revision_id: doc.head_revision_id, content, content_hash: await sha256Hex(content) }, uuidv7());
  }
}
