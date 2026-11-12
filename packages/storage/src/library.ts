import {
  AppError,
  compareNames,
  deriveTitle,
  foldKey,
  sha256Hex,
  uuidv7,
  type DocumentMeta,
  type DocumentSource,
  type Folder,
  type FolderRemote,
  type RemoteRef,
  type Revision,
  type RevisionReason,
} from '@mdr/core';
import type { Backend, Tx } from './backend.ts';
import { SearchIndex, type SearchHit } from './search.ts';
import { HISTORY_RETENTION_KEY, retainedRevisions, type HistoryRetention } from './retention.ts';

interface ContentRow {
  hash: string;
  text: string;
}

export interface CreateDocumentInput {
  text: string;
  fileName: string;
  bom?: boolean;
  source?: DocumentSource;
  folderId?: string | null;
  tags?: string[];
  /** Server-assigned or client-chosen id (sync keeps ids identical on all devices). */
  id?: string;
  remote?: RemoteRef | null;
  reason?: RevisionReason;
}

export type MetaPatch = Partial<Pick<DocumentMeta, 'title' | 'fileName' | 'folderId' | 'tags' | 'favorite' | 'openedAt' | 'source' | 'remote'>>;

export interface SyncBase {
  documentId: string;
  hash: string;
  text: string;
}

export type LibraryListener = (documentIds: string[]) => void;

export interface LibraryOptions {
  libraryId?: string;
  /** A new revision is cut when the head revision is older than this (ADR-002). */
  revisionIntervalMs?: number;
  now?: () => number;
}

/**
 * Local library: documents, content-addressed text, revision history, folders and search.
 * Saves are compare-and-swap on the content hash, so a stale tab or device can never overwrite
 * newer text silently.
 */
export class Library {
  readonly libraryId: string;
  private readonly revisionIntervalMs: number;
  private readonly now: () => number;
  private readonly index: SearchIndex | null;
  private indexReady: Promise<void> | null = null;
  private readonly listeners = new Set<LibraryListener>();

  constructor(private readonly backend: Backend, options: LibraryOptions = {}) {
    this.libraryId = options.libraryId ?? 'local';
    this.index = backend.search ? null : new SearchIndex();
    this.revisionIntervalMs = options.revisionIntervalMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Notified after documents change (content, metadata, trash). Used by sync and the UI. */
  onChange(listener: LibraryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(...ids: string[]): void {
    for (const listener of this.listeners) listener(ids);
  }

  async listDocuments(options: { includeTrashed?: boolean } = {}): Promise<DocumentMeta[]> {
    const docs = await this.backend.transaction(['documents'], 'readonly', (tx) => tx.getAll<DocumentMeta>('documents'));
    return docs.filter((d) => options.includeTrashed || d.deletedAt === null);
  }

  async getDocument(id: string): Promise<DocumentMeta> {
    const doc = await this.backend.transaction(['documents'], 'readonly', (tx) => tx.get<DocumentMeta>('documents', id));
    if (!doc) throw new AppError('document.not_found', { id });
    return doc;
  }

  /** Current text and its version (content hash) for compare-and-swap saves. */
  async readContent(id: string): Promise<{ text: string; version: string; meta: DocumentMeta }> {
    return this.backend.transaction(['documents', 'contents'], 'readonly', async (tx) => {
      const meta = await tx.get<DocumentMeta>('documents', id);
      if (!meta) throw new AppError('document.not_found', { id });
      const content = await tx.get<ContentRow>('contents', meta.contentHash);
      if (!content) throw new AppError('storage.failed', { id, reason: 'missing_content' });
      return { text: content.text, version: meta.contentHash, meta };
    });
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentMeta> {
    const hash = await sha256Hex(input.text);
    const now = this.iso();
    const id = input.id ?? uuidv7(this.now());
    const revision: Revision = {
      id: uuidv7(this.now()),
      documentId: id,
      parentRevisionId: null,
      contentHash: hash,
      size: input.text.length,
      authorId: null,
      reason: input.reason ?? 'import',
      createdAt: now,
    };
    const meta: DocumentMeta = {
      id,
      libraryId: this.libraryId,
      folderId: input.folderId ?? null,
      title: deriveTitle(input.text, input.fileName) || input.fileName,
      fileName: input.fileName,
      source: input.source ?? { kind: 'imported' },
      headRevisionId: revision.id,
      contentHash: hash,
      bom: input.bom ?? false,
      tags: normalizeTags(input.tags ?? []),
      favorite: false,
      createdAt: now,
      updatedAt: now,
      openedAt: null,
      deletedAt: null,
      remote: input.remote ?? null,
    };
    await this.backend.transaction(['documents', 'contents', 'revisions', 'folders'], 'readwrite', async (tx) => {
      await this.requireFolder(tx, meta.folderId);
      if (await tx.get('documents', id)) throw new AppError('storage.failed', { id, reason: 'duplicate_id' });
      await tx.put<ContentRow>('contents', { hash, text: input.text });
      await tx.put('revisions', revision);
      await tx.put('documents', meta);
    });
    this.index?.upsert(id, meta.title, input.text);
    this.emit(id);
    return meta;
  }

  /**
   * Saves `text` if the stored version still equals `baseVersion`; otherwise throws
   * `file.external_change`. Returns the new version.
   */
  async saveContent(id: string, text: string, baseVersion: string, reason: RevisionReason = 'edit'): Promise<string> {
    const hash = await sha256Hex(text);
    const nowMs = this.now();
    const now = new Date(nowMs).toISOString();
    const meta = await this.backend.transaction(['documents', 'contents', 'revisions'], 'readwrite', async (tx) => {
      const meta = await tx.get<DocumentMeta>('documents', id);
      if (!meta) throw new AppError('document.not_found', { id });
      if (meta.contentHash !== baseVersion) {
        throw new AppError('file.external_change', { id, expected: baseVersion, actual: meta.contentHash });
      }
      if (hash === baseVersion) return meta;

      await tx.put<ContentRow>('contents', { hash, text });
      const head = await tx.get<Revision>('revisions', meta.headRevisionId);
      const cutNew = !head || reason !== 'edit' || head.reason !== 'edit' || nowMs - Date.parse(head.createdAt) >= this.revisionIntervalMs;
      if (cutNew) {
        const revision: Revision = {
          id: uuidv7(nowMs),
          documentId: id,
          parentRevisionId: head?.id ?? null,
          contentHash: hash,
          size: text.length,
          authorId: null,
          reason,
          createdAt: now,
        };
        await tx.put('revisions', revision);
        meta.headRevisionId = revision.id;
      } else {
        // Group rapid edits into the open head revision; its content row is replaced.
        const previous = head.contentHash;
        await tx.put('revisions', { ...head, contentHash: hash, size: text.length });
        await this.dropContentIfUnreferenced(tx, previous, id);
      }
      meta.contentHash = hash;
      meta.updatedAt = now;
      const title = deriveTitle(text, meta.fileName);
      if (title) meta.title = title;
      await tx.put('documents', meta);
      return meta;
    });
    this.index?.upsert(id, meta.title, text);
    this.emit(id);
    return hash;
  }

  async updateMeta(id: string, patch: MetaPatch): Promise<DocumentMeta> {
    let retitled: string | null = null;
    const next = await this.backend.transaction(['documents', 'folders', 'contents'], 'readwrite', async (tx) => {
      const meta = await tx.get<DocumentMeta>('documents', id);
      if (!meta) throw new AppError('document.not_found', { id });
      if (patch.folderId !== undefined) await this.requireFolder(tx, patch.folderId);
      const next: DocumentMeta = { ...meta, ...patch, tags: patch.tags ? normalizeTags(patch.tags) : meta.tags };
      if (patch.fileName !== undefined && patch.title === undefined && patch.fileName !== meta.fileName) {
        // Without a heading the file name is the title, so a rename must show up in the list.
        const content = await tx.get<ContentRow>('contents', meta.contentHash);
        next.title = deriveTitle(content?.text ?? '', patch.fileName) || patch.fileName;
        if (next.title !== meta.title && meta.deletedAt === null) retitled = content?.text ?? '';
      }
      if (patch.title !== undefined || patch.fileName !== undefined || patch.folderId !== undefined || patch.tags !== undefined) {
        next.updatedAt = this.iso();
      }
      await tx.put('documents', next);
      return next;
    });
    // Search matches titles too.
    if (retitled !== null) this.index?.upsert(id, next.title, retitled);
    // `openedAt` alone is bookkeeping, not a change worth syncing or re-rendering for.
    if (Object.keys(patch).some((k) => k !== 'openedAt')) this.emit(id);
    return next;
  }

  async trash(id: string): Promise<void> {
    await this.setDeleted(id, this.iso());
    this.index?.remove(id);
    this.emit(id);
  }

  async restore(id: string): Promise<void> {
    await this.setDeleted(id, null);
    const { text, meta } = await this.readContent(id);
    this.index?.upsert(id, meta.title, text);
    this.emit(id);
  }

  /** Permanently deletes a trashed document with all revisions and unreferenced contents. */
  async purge(id: string): Promise<void> {
    await this.backend.transaction(['documents', 'contents', 'revisions', 'syncBases'], 'readwrite', async (tx) => {
      const meta = await tx.get<DocumentMeta>('documents', id);
      if (!meta) return;
      if (meta.deletedAt === null) throw new AppError('storage.failed', { id, reason: 'not_trashed' });
      const revisions = await tx.revisionsOf<Revision>(id);
      await tx.delete('documents', id);
      for (const r of revisions) await tx.delete('revisions', r.id);
      for (const hash of new Set(revisions.map((r) => r.contentHash))) await this.dropContentIfUnreferenced(tx, hash, null);
      await tx.delete('syncBases', id);
    });
    this.index?.remove(id);
    this.emit(id);
  }

  /** Last text known to be identical on the server (common ancestor for merges). */
  async getSyncBase(id: string): Promise<SyncBase | null> {
    return (await this.backend.transaction(['syncBases'], 'readonly', (tx) => tx.get<SyncBase>('syncBases', id))) ?? null;
  }

  async putSyncBase(base: SyncBase): Promise<void> {
    await this.backend.transaction(['syncBases'], 'readwrite', (tx) => tx.put('syncBases', base));
  }

  async deleteSyncBase(id: string): Promise<void> {
    await this.backend.transaction(['syncBases'], 'readwrite', (tx) => tx.delete('syncBases', id));
  }

  async getSetting<T>(key: string): Promise<T | null> {
    const row = await this.backend.transaction(['settings'], 'readonly', (tx) => tx.get<{ key: string; value: T }>('settings', key));
    return row?.value ?? null;
  }

  async putSetting<T>(key: string, value: T | null): Promise<void> {
    await this.backend.transaction(['settings'], 'readwrite', (tx) => (value === null ? tx.delete('settings', key) : tx.put('settings', { key, value })));
  }

  async listRevisions(id: string): Promise<Revision[]> {
    const revisions = await this.backend.transaction(['revisions'], 'readonly', (tx) => tx.revisionsOf<Revision>(id));
    return revisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async getHistoryRetention(): Promise<HistoryRetention> {
    return (await this.getSetting<unknown>(HISTORY_RETENTION_KEY)) === 'balanced' ? 'balanced' : 'all';
  }

  async setHistoryRetention(policy: HistoryRetention): Promise<void> {
    if (policy !== 'all' && policy !== 'balanced') throw new AppError('storage.failed');
    await this.putSetting(HISTORY_RETENTION_KEY, policy);
  }

  /** Explicit maintenance only. A policy change alone never deletes history. */
  async pruneHistory(): Promise<number> {
    return this.backend.transaction(['settings', 'documents', 'revisions', 'contents'], 'readwrite', async (tx) => {
      const policy = await tx.get<{ value: unknown }>('settings', HISTORY_RETENTION_KEY);
      if (policy?.value !== 'balanced') return 0;
      const docs = await tx.getAll<DocumentMeta>('documents');
      const revisions = await tx.getAll<Revision>('revisions');
      const byDocument = new Map<string, Revision[]>();
      for (const revision of revisions) {
        const group = byDocument.get(revision.documentId) ?? [];
        group.push(revision);
        byDocument.set(revision.documentId, group);
      }
      const removed = new Set<string>();
      const hashes = new Set<string>();
      for (const doc of docs) {
        if (doc.deletedAt !== null) continue;
        const group = byDocument.get(doc.id) ?? [];
        const keep = retainedRevisions(group, doc.headRevisionId, this.now());
        const byId = new Map(group.map((revision) => [revision.id, revision]));
        for (const revision of group) {
          if (!keep.has(revision.id)) {
            await tx.delete('revisions', revision.id);
            removed.add(revision.id);
            hashes.add(revision.contentHash);
          } else {
            let parent = revision.parentRevisionId;
            const visited = new Set([revision.id]);
            while (parent && !keep.has(parent) && !visited.has(parent)) {
              visited.add(parent);
              parent = byId.get(parent)?.parentRevisionId ?? null;
            }
            if (parent && visited.has(parent)) parent = null;
            if (parent !== revision.parentRevisionId) await tx.put('revisions', { ...revision, parentRevisionId: parent });
          }
        }
      }
      // Shared content remains while any document head or retained revision references it.
      const referenced = new Set([...docs.map((doc) => doc.contentHash), ...revisions.filter((r) => !removed.has(r.id)).map((r) => r.contentHash)]);
      for (const hash of hashes) if (!referenced.has(hash)) await tx.delete('contents', hash);
      return removed.size;
    });
  }

  async readRevision(revisionId: string, documentId?: string): Promise<string> {
    return this.backend.transaction(['revisions', 'contents'], 'readonly', async (tx) => {
      const revision = await tx.get<Revision>('revisions', revisionId);
      if (!revision || (documentId !== undefined && revision.documentId !== documentId)) {
        throw new AppError('document.not_found', { revisionId });
      }
      const content = await tx.get<ContentRow>('contents', revision.contentHash);
      if (!content) throw new AppError('storage.failed', { revisionId, reason: 'missing_content' });
      return content.text;
    });
  }

  /** Restores an old revision as a *new* head revision; history is never rewritten. */
  async restoreRevision(id: string, revisionId: string): Promise<string> {
    const text = await this.readRevision(revisionId, id);
    const { version } = await this.readContent(id);
    return this.saveContent(id, text, version, 'restore');
  }

  async listFolders(options: { includeTrashed?: boolean } = {}): Promise<Folder[]> {
    const folders = await this.backend.transaction(['folders'], 'readonly', (tx) => tx.getAll<Folder>('folders'));
    return folders.filter((f) => options.includeTrashed || f.deletedAt === null);
  }

  async createFolder(name: string, parentId: string | null = null): Promise<Folder> {
    const folder: Folder = { id: uuidv7(this.now()), libraryId: this.libraryId, parentId, name: name.normalize('NFC').trim(), createdAt: this.iso(), deletedAt: null };
    await this.backend.transaction(['folders'], 'readwrite', async (tx) => {
      await this.validateFolder(tx, folder);
      await tx.put('folders', folder);
    });
    this.emit();
    return folder;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    await this.backend.transaction(['folders'], 'readwrite', async (tx) => {
      const folder = (await this.requireFolder(tx, id))!;
      const next = { ...folder, name: name.normalize('NFC').trim() };
      await this.validateFolder(tx, next);
      await tx.put('folders', next);
    });
    this.emit();
  }

  /**
   * Writes a folder as the server has it (sync). Unlike user edits, a duplicate sibling name is
   * accepted: two devices may have created the same name concurrently. A deleted folder is restored.
   */
  async putSyncedFolder(input: { id: string; parentId: string | null; name: string; remote: FolderRemote }): Promise<void> {
    await this.backend.transaction(['folders'], 'readwrite', async (tx) => {
      await this.requireFolder(tx, input.parentId);
      const existing = await tx.get<Folder>('folders', input.id);
      const folder: Folder = existing
        ? { ...existing, parentId: input.parentId, name: input.name, remote: input.remote, deletedAt: null }
        : { id: input.id, libraryId: this.libraryId, parentId: input.parentId, name: input.name, createdAt: this.iso(), deletedAt: null, remote: input.remote };
      await tx.put('folders', folder);
    });
    this.emit();
  }

  /** Sync bookkeeping only: what the server has for this folder (also for trashed folders). */
  async setFolderRemote(id: string, remote: FolderRemote | null): Promise<void> {
    await this.backend.transaction(['folders'], 'readwrite', async (tx) => {
      const folder = await tx.get<Folder>('folders', id);
      if (folder) await tx.put('folders', { ...folder, remote });
    });
  }

  /**
   * Gives a folder the id the server uses for it (the server already had a folder with this name
   * there). Subfolders and documents move along; if `newId` exists locally the two are merged.
   */
  async rekeyFolder(oldId: string, newId: string, remote: FolderRemote): Promise<void> {
    const moved = await this.backend.transaction(['folders', 'documents'], 'readwrite', async (tx) => {
      const old = await tx.get<Folder>('folders', oldId);
      if (!old) throw new AppError('folder.not_found', { id: oldId });
      const target = await tx.get<Folder>('folders', newId);
      await tx.put('folders', { ...(target ?? old), id: newId, parentId: old.parentId, name: remote.baseName, deletedAt: null, remote });
      for (const f of await tx.getAll<Folder>('folders')) if (f.parentId === oldId) await tx.put('folders', { ...f, parentId: newId });
      const docs = (await tx.getAll<DocumentMeta>('documents')).filter((d) => d.folderId === oldId);
      for (const d of docs) await tx.put('documents', { ...d, folderId: newId });
      await tx.delete('folders', oldId);
      return docs.map((d) => d.id);
    });
    this.emit(...moved);
  }

  /** Moves a folder; refuses to create cycles. */
  async moveFolder(id: string, parentId: string | null): Promise<void> {
    await this.backend.transaction(['folders'], 'readwrite', async (tx) => {
      const all = await tx.getAll<Folder>('folders');
      const byId = new Map(all.map((f) => [f.id, f]));
      const visited = new Set([id]);
      for (let cur = parentId; cur !== null; cur = byId.get(cur)?.parentId ?? null) {
        if (visited.has(cur)) throw new AppError('folder.cycle', { reason: 'folder_cycle' });
        visited.add(cur);
      }
      const folder = (await this.requireFolder(tx, id))!;
      const next = { ...folder, parentId };
      await this.validateFolder(tx, next);
      await tx.put('folders', next);
    });
    this.emit();
  }

  /** Trashes a folder and everything below it. */
  async trashFolder(id: string): Promise<void> {
    const now = this.iso();
    const trashedDocs = await this.backend.transaction(['folders', 'documents'], 'readwrite', async (tx) => {
      const folders = await tx.getAll<Folder>('folders');
      const ids = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id);
          grew = true;
        }
      }
      for (const f of folders) if (ids.has(f.id)) await tx.put('folders', { ...f, deletedAt: now });
      const docs = (await tx.getAll<DocumentMeta>('documents')).filter((d) => d.folderId && ids.has(d.folderId) && d.deletedAt === null);
      for (const d of docs) await tx.put('documents', { ...d, deletedAt: now });
      return docs.map((d) => d.id);
    });
    for (const docId of trashedDocs) this.index?.remove(docId);
    this.emit(...trashedDocs);
  }

  async listTags(locale: string): Promise<Array<{ tag: string; count: number }>> {
    // Tags compare case-insensitively; the first spelling seen is displayed.
    const counts = new Map<string, { tag: string; count: number }>();
    for (const doc of await this.listDocuments()) {
      for (const tag of doc.tags) {
        const entry = counts.get(foldKey(tag));
        if (entry) entry.count++;
        else counts.set(foldKey(tag), { tag, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => compareNames(a.tag, b.tag, locale));
  }

  async search(query: string, limit?: number): Promise<SearchHit[]> {
    if (this.backend.search) return this.backend.search(query, limit);
    await this.ensureIndex();
    return this.index!.search(query, limit);
  }

  /** Builds the search index lazily from stored contents (first search after startup). */
  private ensureIndex(): Promise<void> {
    this.indexReady ??= (async () => {
      const docs = await this.listDocuments();
      for (const doc of docs) {
        const { text } = await this.readContent(doc.id);
        this.index?.upsert(doc.id, doc.title, text);
      }
    })();
    return this.indexReady;
  }

  private async requireFolder(tx: Tx, id: string | null): Promise<Folder | null> {
    if (id === null) return null;
    const folder = await tx.get<Folder>('folders', id);
    if (!folder || folder.deletedAt !== null || folder.libraryId !== this.libraryId) {
      throw new AppError('folder.not_found', { id });
    }
    return folder;
  }

  private async validateFolder(tx: Tx, folder: Folder): Promise<void> {
    if (!folder.name) throw new AppError('folder.invalid_name');
    await this.requireFolder(tx, folder.parentId);
    const all = await tx.getAll<Folder>('folders');
    if (all.some((f) => f.id !== folder.id && f.libraryId === folder.libraryId && f.parentId === folder.parentId && f.deletedAt === null && foldKey(f.name) === foldKey(folder.name))) {
      throw new AppError('folder.duplicate_name');
    }
  }

  private async setDeleted(id: string, deletedAt: string | null): Promise<void> {
    await this.backend.transaction(['documents'], 'readwrite', async (tx) => {
      const meta = await tx.get<DocumentMeta>('documents', id);
      if (!meta) throw new AppError('document.not_found', { id });
      await tx.put('documents', { ...meta, deletedAt });
    });
  }

  private async dropContentIfUnreferenced(tx: Tx, hash: string, exceptDocument: string | null): Promise<void> {
    // Contents are shared across documents (dedup), so check every revision and document head.
    const docs = await tx.getAll<DocumentMeta>('documents');
    if (docs.some((d) => d.contentHash === hash && d.id !== exceptDocument)) return;
    const revisions = await tx.getAll<Revision>('revisions');
    if (revisions.some((r) => r.contentHash === hash)) return;
    await tx.delete('contents', hash);
  }
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of tags) {
    const tag = raw.normalize('NFC').trim().replace(/^#/, '');
    if (tag && !seen.has(foldKey(tag))) seen.set(foldKey(tag), tag);
  }
  return [...seen.values()];
}
