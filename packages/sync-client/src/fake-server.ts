import { sha256Hex, uuidv7 } from '@mdr/core';
import { SyncHttpError, type SyncApi } from './api.ts';
import type { ChangesResponse, CreateDocumentRequest, DocumentInfo, DocumentWithContent, LibraryInfo, MeResponse, UpdateContentRequest } from './protocol.ts';

interface StoredDoc extends DocumentInfo {
  content: string;
  seq: number;
  revisions: number;
}

/**
 * In-memory implementation of the server semantics the sync engine relies on: compare-and-swap
 * content updates, idempotency keys, a sequence-ordered change feed with tombstones. Used by tests;
 * the real server is covered by `apps/server/tests/api.rs`.
 */
export class FakeServer {
  readonly docs = new Map<string, StoredDoc>();
  private readonly ops = new Map<string, DocumentInfo>();
  private seq = 0;
  readonly libraryId = uuidv7();
  /** The next call of this operation fails as if the network dropped *after* the server applied it. */
  dropResponseOf: 'createDocument' | 'updateContent' | 'deleteDocument' | null = null;
  offline = false;
  /** When set, the server has no users yet and accepts this setup token once. */
  setupToken: string | null = null;

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
    const signIn = (username: string) => {
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
      me: () => guard(async () => me),
      login: (username) => guard(async () => signIn(username)),
      logout: () => guard(async () => undefined),
      listLibraries: () => guard(async (): Promise<LibraryInfo[]> => [{ id: this.libraryId, name: 'Shared', role: 'owner' }]),
      createLibrary: (name) => guard(async (): Promise<LibraryInfo> => ({ id: this.libraryId, name, role: 'owner' })),
      changes: (_lib, cursor) => guard(async () => this.changes(cursor)),
      getDocument: (id) => guard(async () => this.get(id)),
      createDocument: (_lib, req, opId) => guard(() => this.create(req, opId), 'createDocument'),
      updateContent: (id, req, opId) => guard(() => this.update(id, req, opId), 'updateContent'),
      deleteDocument: (id) => guard(async () => this.remove(id), 'deleteDocument'),
    };
  }

  private info(doc: StoredDoc): DocumentInfo {
    const { content: _c, seq: _s, revisions: _r, ...info } = doc;
    return info;
  }

  private changes(cursor: string): ChangesResponse {
    const after = Number(cursor || 0);
    const docs = [...this.docs.values()].filter((d) => d.seq > after).sort((a, b) => a.seq - b.seq);
    return { documents: docs.map((d) => this.info(d)), cursor: String(docs.at(-1)?.seq ?? after), has_more: false };
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
      folder_id: null,
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
