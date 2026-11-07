import { AppError, sha256Hex, threeWayMerge, type DocumentMeta, type ErrorCode, type RemoteRef } from '@mdr/core';
import type { Library } from '@mdr/storage';
import { SyncHttpError, toSyncAppError, type SyncApi } from './api.ts';
import type { ConflictDetails, DocumentInfo, DocumentWithContent } from './protocol.ts';

/** Persisted (in library settings) description of the one server library this device syncs. */
export interface SyncConnection {
  /** `<origin>|<userId>`: identifies the account the copies belong to. */
  serverId: string;
  baseUrl: string;
  userId: string;
  username: string;
  libraryId: string;
  libraryName: string;
  /** Local folder holding the synced documents. Every document in it is synced. */
  folderId: string;
  cursor: string;
}

export type SyncState =
  | { kind: 'synced'; at: number }
  | { kind: 'pending' }
  | { kind: 'syncing' }
  | { kind: 'offline'; retryAt: number }
  | { kind: 'conflict'; count: number }
  | { kind: 'error'; code: ErrorCode };

export interface SyncEngineOptions {
  saveConnection(connection: SyncConnection): Promise<void>;
  onState?(state: SyncState): void;
  /** Documents whose content or metadata the engine changed (open editors should reload). */
  onRemoteChange?(ids: string[]): void;
  /** Runs before each sync, e.g. to flush unsaved editor text into the library. */
  beforeSync?(): Promise<void>;
  /** Debounce before syncing local edits. */
  pushDelayMs?: number;
  /** Periodic pull interval while running. */
  pollIntervalMs?: number;
  random?: () => number;
}

export const SYNC_CONNECTION_KEY = 'sync.connection';

/** Deterministic idempotency key: retrying the same logical operation reuses it. */
export async function operationId(...parts: string[]): Promise<string> {
  const hex = await sha256Hex(parts.join('|'));
  // Format as a UUIDv8 (custom) so the server's UUID parser accepts it.
  const h = hex.slice(0, 32).split('');
  h[12] = '8';
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Full-jitter exponential backoff: 1 s, 2 s, 4 s … capped at 5 min. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(300_000, 1000 * 2 ** Math.min(attempt, 12));
  return Math.round(random() * cap);
}

/**
 * Two-way sync between one local folder and one server library.
 *
 * - Local edits are durable before any network call; "pending" is derived from
 *   `contentHash !== remote.baseHash`, so nothing is lost if the app closes mid-sync.
 * - Uploads are compare-and-swap on the server head revision. A stale base triggers a
 *   three-way merge against the stored common ancestor; when it is not clean the document is
 *   marked as conflicted and nothing is overwritten on either side.
 * - Remote deletions remove unmodified local copies; modified copies are kept as local documents.
 */
export class SyncEngine {
  private state: SyncState = { kind: 'pending' };
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private applying = 0;
  private unsubscribe: (() => void) | null = null;
  private stopped = true;

  constructor(
    private readonly library: Library,
    private readonly api: SyncApi,
    private connection: SyncConnection,
    private readonly options: SyncEngineOptions,
  ) {}

  get current(): SyncState {
    return this.state;
  }

  get conn(): SyncConnection {
    return this.connection;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = this.library.onChange(() => {
      if (this.applying === 0) this.schedule(this.options.pushDelayMs ?? 1500);
    });
    const interval = this.options.pollIntervalMs ?? 60_000;
    if (interval > 0) this.poll = setInterval(() => this.schedule(0), interval);
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.timer = null;
    this.poll = null;
  }

  /** Schedules a sync (coalescing requests). */
  schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, delayMs);
  }

  /** Runs one full sync (pull + push). Concurrent calls share a run and trigger one more. */
  async syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.runOnce();
      } while (this.again);
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  private setState(state: SyncState): void {
    this.state = state;
    this.options.onState?.(state);
  }

  private async runOnce(): Promise<void> {
    this.setState({ kind: 'syncing' });
    const changed = new Set<string>();
    try {
      await this.options.beforeSync?.();
      await this.pull(changed);
      await this.push(changed);
      this.attempt = 0;
      this.setState(await this.summarize());
    } catch (error) {
      const appError = toSyncAppError(error);
      if (appError.code === 'sync.offline' || appError.code === 'server.unavailable') {
        const delay = backoffDelay(this.attempt++, this.options.random);
        this.setState({ kind: 'offline', retryAt: Date.now() + delay });
        this.schedule(delay);
      } else {
        // Auth or access problems need the user; do not hammer the server.
        this.setState({ kind: 'error', code: appError.code });
      }
    } finally {
      if (changed.size) this.options.onRemoteChange?.([...changed]);
    }
  }

  private async summarize(): Promise<SyncState> {
    let conflicts = 0;
    let pending = false;
    for (const doc of await this.syncedDocuments()) {
      if (doc.remote?.conflict) conflicts++;
      else if (this.isPending(doc)) pending = true;
    }
    if (conflicts) return { kind: 'conflict', count: conflicts };
    return pending ? { kind: 'pending' } : { kind: 'synced', at: Date.now() };
  }

  private isPending(doc: DocumentMeta): boolean {
    if (doc.deletedAt !== null) return Boolean(doc.remote?.baseRevisionId);
    return !doc.remote?.baseRevisionId || doc.contentHash !== doc.remote.baseHash;
  }

  private belongs(doc: DocumentMeta): boolean {
    const r = doc.remote;
    if (r) return r.serverId === this.connection.serverId && r.libraryId === this.connection.libraryId;
    return doc.folderId === this.connection.folderId && doc.deletedAt === null;
  }

  private async syncedDocuments(): Promise<DocumentMeta[]> {
    return (await this.library.listDocuments({ includeTrashed: true })).filter((d) => this.belongs(d));
  }

  private remoteRef(info: { head_revision_id: string; content_hash: string }): RemoteRef {
    return {
      serverId: this.connection.serverId,
      libraryId: this.connection.libraryId,
      baseRevisionId: info.head_revision_id,
      baseHash: info.content_hash,
      conflict: null,
    };
  }

  /** Engine-originated library writes must not re-trigger syncing. */
  private async applying_<T>(fn: () => Promise<T>): Promise<T> {
    this.applying++;
    try {
      return await fn();
    } finally {
      this.applying--;
    }
  }

  // ---------- Pull ----------

  private async pull(changed: Set<string>): Promise<void> {
    for (;;) {
      const page = await this.api.changes(this.connection.libraryId, this.connection.cursor);
      for (const info of page.documents) await this.applyRemote(info, changed);
      this.connection = { ...this.connection, cursor: page.cursor };
      await this.options.saveConnection(this.connection);
      if (!page.has_more) return;
    }
  }

  private async findLocal(id: string): Promise<DocumentMeta | null> {
    try {
      return await this.library.getDocument(id);
    } catch (error) {
      if (error instanceof AppError && error.code === 'document.not_found') return null;
      throw error;
    }
  }

  private async applyRemote(info: DocumentInfo, changed: Set<string>): Promise<void> {
    let local = await this.findLocal(info.id);
    if (local && !this.belongs(local)) return; // Same id elsewhere: never touch unrelated documents.

    if (info.deleted_at) {
      if (!local) return;
      await this.applying_(async () => {
        if (local!.deletedAt === null && !this.isPending(local!)) await this.library.trash(info.id);
        // Modified or not, the copy is no longer linked to the server; edits stay local.
        await this.library.updateMeta(info.id, { remote: null, folderId: local!.deletedAt === null && this.isPending(local!) ? null : local!.folderId });
        await this.library.deleteSyncBase(info.id);
      });
      changed.add(info.id);
      return;
    }

    if (!local) {
      const full = await this.api.getDocument(info.id);
      await this.applying_(async () => {
        await this.library.createDocument({
          id: full.id,
          text: full.content,
          fileName: full.file_name,
          folderId: this.connection.folderId,
          remote: this.remoteRef(full),
          reason: 'sync',
        });
        await this.library.putSyncBase({ documentId: full.id, hash: full.content_hash, text: full.content });
      });
      changed.add(info.id);
      return;
    }

    const remote = local.remote;
    if (remote?.baseRevisionId === info.head_revision_id || remote?.conflict?.revisionId === info.head_revision_id) return;
    const full = await this.api.getDocument(info.id);
    if (local.deletedAt !== null) {
      // Someone edited a document we deleted locally: keep their edit, undo our delete.
      await this.applying_(() => this.library.restore(info.id));
      local = await this.library.getDocument(info.id);
    }
    await this.integrate(local, full);
    changed.add(info.id);
  }

  /** Brings a newer server version into a local document (fast-forward, merge, or conflict). */
  private async integrate(local: DocumentMeta, theirs: DocumentWithContent): Promise<void> {
    const { text: ours, version } = await this.library.readContent(local.id);
    const ref = this.remoteRef(theirs);
    await this.applying_(async () => {
      if (version === theirs.content_hash) {
        await this.library.updateMeta(local.id, { remote: ref });
      } else if (!local.remote?.baseRevisionId) {
        // Unknown ancestry (e.g. a copy kept after signing out, now re-linked): never guess.
        await this.library.updateMeta(local.id, {
          remote: { ...ref, conflict: { revisionId: theirs.head_revision_id, hash: theirs.content_hash } },
        });
        return;
      } else if (version === local.remote.baseHash) {
        // No local changes since the last sync: fast-forward.
        await this.library.saveContent(local.id, theirs.content, version, 'sync');
        await this.library.updateMeta(local.id, { remote: ref });
      } else {
        const base = (await this.library.getSyncBase(local.id))?.text ?? '';
        const merged = threeWayMerge(base, ours, theirs.content);
        if (merged.clean) {
          // New base = theirs; the merged text is pending and uploads on top of their head.
          if (merged.text !== ours) await this.library.saveContent(local.id, merged.text, version, 'merge');
          await this.library.updateMeta(local.id, { remote: ref });
        } else {
          await this.library.updateMeta(local.id, {
            remote: { ...(local.remote ?? ref), conflict: { revisionId: theirs.head_revision_id, hash: theirs.content_hash } },
          });
          return;
        }
      }
      await this.library.putSyncBase({ documentId: local.id, hash: theirs.content_hash, text: theirs.content });
    });
  }

  // ---------- Push ----------

  private async push(changed: Set<string>): Promise<void> {
    for (const doc of await this.syncedDocuments()) {
      if (doc.remote?.conflict || !this.isPending(doc)) continue;
      if (doc.deletedAt !== null) {
        await this.pushDelete(doc);
        continue;
      }
      if (!doc.remote?.baseRevisionId) await this.pushCreate(doc, changed);
      else await this.pushUpdate(doc, changed, 0);
    }
  }

  private async pushDelete(doc: DocumentMeta): Promise<void> {
    try {
      await this.api.deleteDocument(doc.id);
    } catch (error) {
      if (!(error instanceof SyncHttpError && error.code === 'document.not_found')) throw error;
    }
    await this.applying_(async () => {
      await this.library.updateMeta(doc.id, { remote: null });
      await this.library.deleteSyncBase(doc.id);
    });
  }

  private async pushCreate(doc: DocumentMeta, changed: Set<string>): Promise<void> {
    const { text, version } = await this.library.readContent(doc.id);
    const opId = await operationId('create', doc.id, version);
    let info: DocumentInfo;
    try {
      info = await this.api.createDocument(this.connection.libraryId, { id: doc.id, file_name: doc.fileName, content: text }, opId);
    } catch (error) {
      if (!(error instanceof SyncHttpError && error.code === 'sync.conflict')) throw error;
      // The id already exists on the server (a re-linked copy): adopt it without overwriting.
      const theirs = await this.api.getDocument(doc.id);
      if (theirs.library_id !== this.connection.libraryId) throw error;
      await this.integrate(doc, theirs);
      changed.add(doc.id);
      return;
    }
    await this.applying_(async () => {
      // Local organization may have changed while the create request was in flight.
      await this.library.updateMeta(doc.id, { remote: this.remoteRef(info) });
      await this.library.putSyncBase({ documentId: doc.id, hash: info.content_hash, text });
    });
    changed.add(doc.id);
  }

  private async pushUpdate(doc: DocumentMeta, changed: Set<string>, depth: number): Promise<void> {
    const { text, version } = await this.library.readContent(doc.id);
    const base = doc.remote!.baseRevisionId!;
    const opId = await operationId('update', doc.id, base, version);
    try {
      const info = await this.api.updateContent(doc.id, { base_revision_id: base, content: text, content_hash: version }, opId);
      await this.applying_(async () => {
        await this.library.updateMeta(doc.id, { remote: this.remoteRef(info) });
        await this.library.putSyncBase({ documentId: doc.id, hash: info.content_hash, text });
      });
    } catch (error) {
      if (error instanceof SyncHttpError && error.code === 'sync.conflict' && depth < 2) {
        // Someone else saved first: merge their head, then retry on top of it.
        const details = error.details as ConflictDetails | null;
        const theirs = await this.api.getDocument(doc.id);
        if (details && theirs.head_revision_id !== details.head_revision_id) changed.add(doc.id);
        await this.integrate(doc, theirs);
        changed.add(doc.id);
        const updated = await this.library.getDocument(doc.id);
        if (!updated.remote?.conflict && this.isPending(updated)) await this.pushUpdate(updated, changed, depth + 1);
        return;
      }
      if (error instanceof SyncHttpError && error.code === 'document.not_found') {
        // Deleted on the server or access lost: keep the text as a local document.
        await this.applying_(async () => {
          await this.library.updateMeta(doc.id, { remote: null, folderId: null });
          await this.library.deleteSyncBase(doc.id);
        });
        changed.add(doc.id);
        return;
      }
      throw error;
    }
  }

  // ---------- Conflict resolution ----------

  /** Keep the local text: it becomes the next server revision on top of theirs. */
  async keepMine(id: string): Promise<void> {
    const doc = await this.library.getDocument(id);
    const conflict = doc.remote?.conflict;
    if (!doc.remote || !conflict) return;
    const theirs = await this.api.getDocument(id);
    await this.applying_(async () => {
      await this.library.updateMeta(id, { remote: { ...this.remoteRef(theirs), conflict: null } });
      await this.library.putSyncBase({ documentId: id, hash: theirs.content_hash, text: theirs.content });
    });
    await this.syncNow();
  }

  /** Replace the local text with the server version (the local text stays in local history). */
  async useServer(id: string): Promise<void> {
    const doc = await this.library.getDocument(id);
    if (!doc.remote?.conflict) return;
    const theirs = await this.api.getDocument(id);
    const { version } = await this.library.readContent(id);
    await this.applying_(async () => {
      await this.library.saveContent(id, theirs.content, version, 'sync');
      await this.library.updateMeta(id, { remote: this.remoteRef(theirs) });
      await this.library.putSyncBase({ documentId: id, hash: theirs.content_hash, text: theirs.content });
    });
    this.options.onRemoteChange?.([id]);
    await this.syncNow();
  }

  /** Keep both: the server version replaces this document, the local text moves to a local-only copy. */
  async keepBoth(id: string, copySuffix: string): Promise<string> {
    const doc = await this.library.getDocument(id);
    const { text } = await this.library.readContent(id);
    const copy = await this.applying_(() =>
      this.library.createDocument({ text, fileName: doc.fileName.replace(/(\.[^.]+)?$/, ` (${copySuffix})$1`), bom: doc.bom, tags: doc.tags }),
    );
    await this.useServer(id);
    return copy.id;
  }

  /** Server version of a conflicted document, for showing a diff. */
  async serverText(id: string): Promise<string> {
    return (await this.api.getDocument(id)).content;
  }
}
