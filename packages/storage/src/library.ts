import {
  AppError,
  compareNames,
  deriveTitle,
  fileTitle,
  fileTypeByMime,
  foldKey,
  isFileDocument,
  sha256Hex,
  uuidv7,
  type DocumentMeta,
  type DocumentSource,
  type Folder,
  type FolderRemote,
  type RemoteRef,
} from '@mdr/core';
import type { Backend, FileRow, Tx } from './backend.ts';
import { SearchIndex, type SearchHit } from './search.ts';

interface ContentRow {
  hash: string;
  text: string;
}

export interface CreateDocumentInput {
  text: string;
  fileName: string;
  bom?: boolean;
  /** WHATWG label of the file's encoding; omit for UTF-8. */
  encoding?: string;
  /** Original non-UTF-8 bytes, kept until the first edit for "Reopen with encoding". */
  originalBytes?: Uint8Array;
  source?: DocumentSource;
  folderId?: string | null;
  tags?: string[];
  /** Server-assigned or client-chosen id (sync keeps ids identical on all devices). */
  id?: string;
  remote?: RemoteRef | null;
}

/** Input for a binary document (docx, xlsx, ods, pdf); see `detectFileType`. */
export interface CreateFileInput {
  bytes: Uint8Array;
  /** Original of import when it differs from `bytes` (a synced, already edited document). */
  originalBytes?: Uint8Array;
  fileName: string;
  mime: string;
  folderId?: string | null;
  tags?: string[];
  id?: string;
  remote?: RemoteRef | null;
}

export type MetaPatch = Partial<Pick<DocumentMeta, 'title' | 'fileName' | 'folderId' | 'tags' | 'favorite' | 'openedAt' | 'source' | 'remote' | 'encoding' | 'bom'>>;

export interface SyncBase {
  documentId: string;
  hash: string;
  text: string;
}

export type LibraryListener = (documentIds: string[]) => void;

export interface LibraryOptions {
  libraryId?: string;
  now?: () => number;
}

/**
 * Local library: documents, content-addressed text and bytes, folders and search. Only the current
 * content of each document is kept (no version history, ADR-008). Saves are compare-and-swap on the
 * content hash, so a stale tab or device can never overwrite newer text silently.
 */
export class Library {
  readonly libraryId: string;
  private readonly now: () => number;
  private readonly index: SearchIndex | null;
  private indexReady: Promise<void> | null = null;
  private readonly listeners = new Set<LibraryListener>();

  constructor(private readonly backend: Backend, options: LibraryOptions = {}) {
    this.libraryId = options.libraryId ?? 'local';
    this.index = backend.search ? null : new SearchIndex();
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
      if (isFileDocument(meta)) throw new AppError('document.not_text', { id });
      const content = await tx.get<ContentRow>('contents', meta.contentHash);
      if (!content) throw new AppError('storage.failed', { id, reason: 'missing_content' });
      return { text: content.text, version: meta.contentHash, meta };
    });
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentMeta> {
    const hash = await sha256Hex(input.text);
    const original = input.originalBytes ? { hash: await sha256Hex(input.originalBytes), bytes: input.originalBytes } : null;
    const now = this.iso();
    const id = input.id ?? uuidv7(this.now());
    const meta: DocumentMeta = {
      id,
      libraryId: this.libraryId,
      folderId: input.folderId ?? null,
      title: deriveTitle(input.text, input.fileName) || input.fileName,
      fileName: input.fileName,
      source: input.source ?? { kind: 'imported' },
      contentHash: hash,
      bom: input.bom ?? false,
      ...(input.encoding && input.encoding !== 'utf-8' ? { encoding: input.encoding } : {}),
      ...(original ? { importBytesHash: original.hash } : {}),
      tags: normalizeTags(input.tags ?? []),
      favorite: false,
      createdAt: now,
      updatedAt: now,
      openedAt: null,
      deletedAt: null,
      remote: input.remote ?? null,
    };
    await this.backend.transaction(['documents', 'contents', 'files', 'folders'], 'readwrite', async (tx) => {
      await this.requireFolder(tx, meta.folderId);
      if (await tx.get('documents', id)) throw new AppError('storage.failed', { id, reason: 'duplicate_id' });
      await tx.put<ContentRow>('contents', { hash, text: input.text });
      if (original && !(await tx.get<FileRow>('files', original.hash))) await tx.put<FileRow>('files', { hash: original.hash, size: original.bytes.length, bytes: original.bytes });
      await tx.put('documents', meta);
    });
    this.index?.upsert(id, meta.title, input.text);
    this.emit(id);
    return meta;
  }

  /** Adds a binary document (docx, xlsx, ods, pdf). The caller validates the type (`detectFileType`). */
  async createFileDocument(input: CreateFileInput): Promise<DocumentMeta> {
    if (!fileTypeByMime(input.mime)) throw new AppError('file.unsupported', { mime: input.mime });
    const hash = await sha256Hex(input.bytes);
    const original = input.originalBytes ? { hash: await sha256Hex(input.originalBytes), bytes: input.originalBytes } : { hash, bytes: input.bytes };
    const now = this.iso();
    const id = input.id ?? uuidv7(this.now());
    const meta: DocumentMeta = {
      id,
      libraryId: this.libraryId,
      kind: 'file',
      mime: input.mime,
      folderId: input.folderId ?? null,
      title: fileTitle(input.fileName),
      fileName: input.fileName,
      source: { kind: 'imported' },
      contentHash: hash,
      originalHash: original.hash,
      bom: false,
      tags: normalizeTags(input.tags ?? []),
      favorite: false,
      createdAt: now,
      updatedAt: now,
      openedAt: null,
      deletedAt: null,
      remote: input.remote ?? null,
    };
    await this.backend.transaction(['documents', 'files', 'folders'], 'readwrite', async (tx) => {
      await this.requireFolder(tx, meta.folderId);
      if (await tx.get('documents', id)) throw new AppError('storage.failed', { id, reason: 'duplicate_id' });
      // Identical bytes are stored once; an existing row is already the same content.
      if (!(await tx.get<FileRow>('files', hash))) await tx.put<FileRow>('files', { hash, size: input.bytes.length, bytes: input.bytes });
      if (original.hash !== hash && !(await tx.get<FileRow>('files', original.hash))) {
        await tx.put<FileRow>('files', { hash: original.hash, size: original.bytes.length, bytes: original.bytes });
      }
      await tx.put('documents', meta);
    });
    this.index?.upsert(id, meta.title, '');
    this.emit(id);
    return meta;
  }

  /** Original bytes of a non-UTF-8 text import that was not edited yet, or null. */
  async readImportBytes(id: string): Promise<Uint8Array | null> {
    return this.backend.transaction(['documents', 'files'], 'readonly', async (tx) => {
      const meta = await tx.get<DocumentMeta>('documents', id);
      if (!meta?.importBytesHash) return null;
      return (await tx.get<FileRow>('files', meta.importBytesHash))?.bytes ?? null;
    });
  }

  /**
   * Replaces the bytes of a binary document if they are still `baseVersion` (compare-and-swap like
   * `saveContent`). No history: the previous bytes go unless the original or another document uses
   * them. Returns the new version (hash).
   */
  async saveFile(id: string, bytes: Uint8Array, baseVersion: string): Promise<string> {
    const hash = await sha256Hex(bytes);
    const now = this.iso();
    await this.backend.transaction(['documents', 'files'], 'readwrite', async (tx) => {
      const meta = await tx.get<DocumentMeta>('documents', id);
      if (!meta) throw new AppError('document.not_found', { id });
      if (!isFileDocument(meta)) throw new AppError('document.not_file', { id });
      if (meta.contentHash !== baseVersion) {
        throw new AppError('file.external_change', { id, expected: baseVersion, actual: meta.contentHash });
      }
      if (hash === baseVersion) return;
      const previous = meta.contentHash;
      if (!(await tx.get<FileRow>('files', hash))) await tx.put<FileRow>('files', { hash, size: bytes.length, bytes });
      // Documents from before originals existed: their bytes so far are the original.
      await tx.put('documents', { ...meta, originalHash: meta.originalHash ?? previous, contentHash: hash, updatedAt: now });
      await this.dropContentIfUnreferenced(tx, previous, null, 'files');
    });
    this.emit(id);
    return hash;
  }

  /** Original of import of a binary document (its first bytes). */
  async readOriginal(id: string): Promise<{ bytes: Uint8Array; meta: DocumentMeta }> {
    return this.backend.transaction(['documents', 'files'], 'readonly', async (tx) => {
      const meta = await tx.get<DocumentMeta>('documents', id);
      if (!meta) throw new AppError('document.not_found', { id });
      if (!isFileDocument(meta)) throw new AppError('document.not_file', { id });
      const row = await tx.get<FileRow>('files', meta.originalHash ?? meta.contentHash);
      if (!row) throw new AppError('storage.failed', { id, reason: 'missing_original' });
      return { bytes: row.bytes, meta };
    });
  }

  /** Bytes of a binary document. Throws `document.not_file` for text documents. */
  async readFile(id: string): Promise<{ bytes: Uint8Array; meta: DocumentMeta }> {
    return this.backend.transaction(['documents', 'files'], 'readonly', async (tx) => {
      const meta = await tx.get<DocumentMeta>('documents', id);
      if (!meta) throw new AppError('document.not_found', { id });
      if (!isFileDocument(meta)) throw new AppError('document.not_file', { id });
      const row = await tx.get<FileRow>('files', meta.contentHash);
      if (!row) throw new AppError('storage.failed', { id, reason: 'missing_content' });
      return { bytes: row.bytes, meta };
    });
  }

  /**
   * Saves `text` if the stored version still equals `baseVersion`; otherwise throws
   * `file.external_change`. Returns the new version.
   */
  async saveContent(id: string, text: string, baseVersion: string, options: { keepImportBytes?: boolean } = {}): Promise<string> {
    const hash = await sha256Hex(text);
    const now = this.iso();
    const meta = await this.backend.transaction(['documents', 'contents', 'files'], 'readwrite', async (tx) => {
      const meta = await tx.get<DocumentMeta>('documents', id);
      if (!meta) throw new AppError('document.not_found', { id });
      if (isFileDocument(meta)) throw new AppError('document.not_text', { id });
      if (meta.contentHash !== baseVersion) {
        throw new AppError('file.external_change', { id, expected: baseVersion, actual: meta.contentHash });
      }
      if (hash === baseVersion) return meta;

      // Only the current text is kept: the previous one goes unless another document shares it.
      const previous = meta.contentHash;
      await tx.put<ContentRow>('contents', { hash, text });
      meta.contentHash = hash;
      meta.updatedAt = now;
      const title = deriveTitle(text, meta.fileName);
      if (title) meta.title = title;
      // After the first edit the imported bytes no longer describe this document.
      const importBytes = options.keepImportBytes ? undefined : meta.importBytesHash;
      if (importBytes) delete meta.importBytesHash;
      await tx.put('documents', meta);
      await this.dropContentIfUnreferenced(tx, previous, null);
      if (importBytes) await this.dropContentIfUnreferenced(tx, importBytes, null, 'files');
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
      // A binary document keeps its type's extension so it opens correctly everywhere.
      const type = isFileDocument(meta) ? fileTypeByMime(meta.mime) : null;
      if (type && patch.fileName !== undefined && !patch.fileName.toLowerCase().endsWith(type.extension)) {
        next.fileName = `${patch.fileName}${type.extension}`;
        patch = { ...patch, fileName: next.fileName };
      }
      if (patch.fileName !== undefined && patch.title === undefined && patch.fileName !== meta.fileName) {
        // Without a heading the file name is the title, so a rename must show up in the list.
        const content = isFileDocument(meta) ? undefined : await tx.get<ContentRow>('contents', meta.contentHash);
        next.title = isFileDocument(meta) ? fileTitle(patch.fileName) : deriveTitle(content?.text ?? '', patch.fileName) || patch.fileName;
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
    const meta = await this.getDocument(id);
    this.index?.upsert(id, meta.title, isFileDocument(meta) ? '' : (await this.readContent(id)).text);
    this.emit(id);
  }

  /** Permanently deletes a trashed document and its content unless another document shares it. */
  async purge(id: string): Promise<void> {
    await this.backend.transaction(['documents', 'contents', 'files', 'syncBases'], 'readwrite', async (tx) => {
      const meta = await tx.get<DocumentMeta>('documents', id);
      if (!meta) return;
      if (meta.deletedAt === null) throw new AppError('storage.failed', { id, reason: 'not_trashed' });
      await tx.delete('documents', id);
      await this.dropContentIfUnreferenced(tx, meta.contentHash, null, isFileDocument(meta) ? 'files' : 'contents');
      if (meta.importBytesHash) await this.dropContentIfUnreferenced(tx, meta.importBytesHash, null, 'files');
      if (meta.originalHash && meta.originalHash !== meta.contentHash) await this.dropContentIfUnreferenced(tx, meta.originalHash, null, 'files');
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
        // Binary documents are found by name only.
        const text = isFileDocument(doc) ? '' : (await this.readContent(doc.id)).text;
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

  private async dropContentIfUnreferenced(tx: Tx, hash: string, exceptDocument: string | null, store: 'contents' | 'files' = 'contents'): Promise<void> {
    // Contents are shared across documents (dedup), so check every reference of every document.
    const docs = await tx.getAll<DocumentMeta>('documents');
    if (docs.some((d) => d.id !== exceptDocument && (d.contentHash === hash || d.importBytesHash === hash || d.originalHash === hash))) return;
    await tx.delete(store, hash);
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
