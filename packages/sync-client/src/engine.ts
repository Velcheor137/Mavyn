import { AppError, sha256Hex, threeWayMerge, type DocumentMeta, type ErrorCode, type Folder, type FolderRemote, type RemoteRef } from '@mdr/core';
import type { Library, MetaPatch } from '@mdr/storage';
import { SyncHttpError, toSyncAppError, type SyncApi } from './api.ts';
import type { ConflictDetails, DocumentInfo, DocumentWithContent, FolderInfo } from './protocol.ts';

/** Persisted (in library settings) description of the one server library this device syncs. */
export interface SyncConnection {
  /** `<origin>|<userId>`: identifies the account the copies belong to. */
  serverId: string;
  baseUrl: string;
  userId: string;
  username: string;
  libraryId: string;
  libraryName: string;
  /** Local folder mirroring the server library root. Everything below it (subfolders too) is synced. */
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

/** Local folders as seen by one sync run. `tree` holds the live folders below the sync root. */
interface FolderView {
  byId: Map<string, Folder>;
  tree: Set<string>;
}

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
 * Two-way sync between one local folder (with all its subfolders) and one server library.
 *
 * - Local edits are durable before any network call; "pending" is derived from
 *   `contentHash !== remote.baseHash`, so nothing is lost if the app closes mid-sync.
 * - Uploads are compare-and-swap on the server head revision. A stale base triggers a
 *   three-way merge against the stored common ancestor; when it is not clean the document is
 *   marked as conflicted and nothing is overwritten on either side.
 * - Remote deletions remove unmodified local copies; modified copies are kept as local documents.
 * - Folders, file names and document locations use the same ids everywhere and sync field by field:
 *   a field changed on one side only takes that side's value; changed on both, the server (first
 *   upload) wins. Items moved out of the synced folder locally keep their place on the server.
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
  private retired = false;
  private readonly operations = new Set<Promise<unknown>>();

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
    if (this.retired) return;
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

  /** Retire this identity and drain sync, conflict resolution and diff requests before logout. */
  async stopAndWait(): Promise<void> {
    this.retired = true;
    this.stop();
    this.again = false;
    await Promise.allSettled([...this.operations, ...(this.running ? [this.running] : [])]);
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
    if (this.retired) return;
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
    const view = await this.view();
    let conflicts = 0;
    let pending = [...view.byId.values()].some((f) => this.isFolderPending(f, view));
    for (const doc of await this.syncedDocuments(view)) {
      if (doc.remote?.conflict) conflicts++;
      else if (this.isPending(doc) || this.isMetaPending(doc, view)) pending = true;
    }
    if (conflicts) return { kind: 'conflict', count: conflicts };
    return pending ? { kind: 'pending' } : { kind: 'synced', at: Date.now() };
  }

  private isPending(doc: DocumentMeta): boolean {
    if (doc.deletedAt !== null) return Boolean(doc.remote?.baseRevisionId);
    return !doc.remote?.baseRevisionId || doc.contentHash !== doc.remote.baseHash;
  }

  /** Last name/location the server is known to have (copies from before folder sync: root, own name). */
  private metaBase(doc: DocumentMeta): { name: string; folder: string | null } {
    return { name: doc.remote?.baseFileName ?? doc.fileName, folder: doc.remote?.baseFolderId ?? null };
  }

  private isMetaPending(doc: DocumentMeta, view: FolderView): boolean {
    if (doc.deletedAt !== null || !doc.remote?.baseRevisionId || doc.remote.conflict) return false;
    const base = this.metaBase(doc);
    const location = this.serverFolderOf(doc.folderId, view);
    return doc.fileName !== base.name || (location !== undefined && location !== base.folder);
  }

  private ownsRemote(remote: { serverId: string; libraryId: string }): boolean {
    return remote.serverId === this.connection.serverId && remote.libraryId === this.connection.libraryId;
  }

  private belongs(doc: DocumentMeta, view: FolderView): boolean {
    if (doc.remote) return this.ownsRemote(doc.remote);
    return doc.deletedAt === null && this.serverFolderOf(doc.folderId, view) !== undefined;
  }

  private async syncedDocuments(view: FolderView): Promise<DocumentMeta[]> {
    return (await this.library.listDocuments({ includeTrashed: true })).filter((d) => this.belongs(d, view));
  }

  private async view(): Promise<FolderView> {
    const byId = new Map((await this.library.listFolders({ includeTrashed: true })).map((f) => [f.id, f]));
    const root = this.connection.folderId;
    const tree = new Set<string>();
    for (const folder of byId.values()) {
      if (folder.deletedAt !== null || folder.id === root) continue;
      let cur = folder.parentId;
      for (let depth = 0; cur !== null && depth < 1000; depth++) {
        const parent = byId.get(cur);
        if (!parent || parent.deletedAt !== null) break;
        if (cur === root) {
          tree.add(folder.id);
          break;
        }
        cur = parent.parentId;
      }
    }
    return { byId, tree };
  }

  /** Server folder for a local folder: null for the sync root, the same id below it, undefined elsewhere. */
  private serverFolderOf(localId: string | null, view: FolderView): string | null | undefined {
    if (localId === this.connection.folderId) return null;
    return localId !== null && view.tree.has(localId) ? localId : undefined;
  }

  /** Local folder for a server folder; the sync root when it is the root or not (yet) known here. */
  private localFolderOf(serverId: string | null, view: FolderView): string {
    return serverId !== null && view.tree.has(serverId) ? serverId : this.connection.folderId;
  }

  private remoteRef(info: DocumentInfo, previous?: RemoteRef | null): RemoteRef {
    return {
      serverId: this.connection.serverId,
      libraryId: this.connection.libraryId,
      baseRevisionId: info.head_revision_id,
      baseHash: info.content_hash,
      conflict: null,
      // Content uploads do not change name/location; only metadata sync moves that base.
      baseFileName: previous ? previous.baseFileName : info.file_name,
      baseFolderId: previous ? previous.baseFolderId : info.folder_id,
    };
  }

  private folderRemote(info: FolderInfo): FolderRemote {
    return { serverId: this.connection.serverId, libraryId: this.connection.libraryId, baseName: info.name, baseParentId: info.parent_id };
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
    const documents = new Map<string, DocumentInfo>();
    const folders = new Map<string, FolderInfo>();
    let cursor = this.connection.cursor;
    for (;;) {
      const page = await this.api.changes(this.connection.libraryId, cursor);
      for (const info of page.documents) documents.set(info.id, info);
      for (const info of page.folders ?? []) folders.set(info.id, info);
      cursor = page.cursor;
      if (!page.has_more) break;
    }
    // Folders first so documents can land in them; folder deletions last so documents the server
    // deleted with them are handled (kept when modified) before the folder goes.
    await this.applyFolders([...folders.values()].filter((f) => !f.deleted_at), changed);
    for (const info of documents.values()) await this.applyRemote(info, changed);
    for (const info of folders.values()) if (info.deleted_at) await this.applyFolderDeletion(info, changed);
    this.connection = { ...this.connection, cursor };
    await this.options.saveConnection(this.connection);
  }

  /** Applies folder upserts parents first (a renamed parent may come later in the feed than its child). */
  private async applyFolders(infos: FolderInfo[], changed: Set<string>): Promise<void> {
    const waiting = new Map(infos.map((f) => [f.id, f]));
    while (waiting.size) {
      const ready = [...waiting.values()].filter((f) => f.parent_id === null || !waiting.has(f.parent_id));
      // A cycle cannot come from the server; if it ever does, place the rest at the root.
      for (const info of ready.length ? ready : [...waiting.values()].map((f) => ({ ...f, parent_id: null }))) {
        waiting.delete(info.id);
        await this.applyRemoteFolder(info, changed);
      }
    }
  }

  private wouldCycle(id: string, parentId: string, view: FolderView): boolean {
    for (let cur: string | null = parentId, depth = 0; cur !== null && depth < 1000; depth++) {
      if (cur === id) return true;
      cur = view.byId.get(cur)?.parentId ?? null;
    }
    return false;
  }

  /**
   * Brings a server folder state into the local folder. `base` is what both sides agreed on before
   * (defaults to the stored base); fields the server did not change keep their local value.
   */
  private async applyRemoteFolder(info: FolderInfo, changed: Set<string>, base?: { name: string; parentId: string | null }): Promise<void> {
    const view = await this.view();
    const local = view.byId.get(info.id);
    if (local?.remote && !this.ownsRemote(local.remote)) return;
    const remote = this.folderRemote(info);
    if (local?.deletedAt != null && local.remote) {
      // Deleted here; the deletion is uploaded next. Only remember what the server had.
      await this.applying_(() => this.library.setFolderRemote(info.id, remote));
      return;
    }
    const agreed = base ?? (local?.remote ? { name: local.remote.baseName, parentId: local.remote.baseParentId } : null);
    let name = info.name;
    let parentId = this.localFolderOf(info.parent_id, view);
    if (local && local.deletedAt === null && agreed) {
      if (info.name === agreed.name) name = local.name;
      const inside = view.tree.has(local.id);
      if (info.parent_id === agreed.parentId || !inside) parentId = local.parentId ?? this.connection.folderId;
    }
    if (parentId !== this.connection.folderId && this.wouldCycle(info.id, parentId, view)) {
      // The server nested this folder below one that was nested below it here, not uploaded yet.
      // The server (first upload) wins: that local move goes back to its server place.
      for (let cur: string | null = parentId; cur !== null && cur !== info.id; ) {
        const folder = view.byId.get(cur);
        if (!folder) break;
        const serverPlace = folder.remote ? this.localFolderOf(folder.remote.baseParentId, view) : null;
        if (folder.remote && serverPlace !== folder.parentId) {
          await this.applying_(() => this.library.putSyncedFolder({ id: folder.id, parentId: serverPlace, name: folder.name, remote: folder.remote! }));
          changed.add(folder.id);
          break;
        }
        cur = folder.parentId;
      }
      if (this.wouldCycle(info.id, parentId, await this.view())) parentId = local?.parentId ?? this.connection.folderId;
    }
    if (local && local.deletedAt === null && local.name === name && local.parentId === parentId) {
      await this.applying_(() => this.library.setFolderRemote(info.id, remote));
      return;
    }
    await this.applying_(() => this.library.putSyncedFolder({ id: info.id, parentId, name, remote }));
    changed.add(info.id);
  }

  private async applyFolderDeletion(info: FolderInfo, changed: Set<string>): Promise<void> {
    const view = await this.view();
    const local = view.byId.get(info.id);
    if (!local || (local.remote && !this.ownsRemote(local.remote))) return;
    const subtree = new Set([info.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of view.byId.values()) if (f.parentId && subtree.has(f.parentId) && !subtree.has(f.id)) {
        subtree.add(f.id);
        grew = true;
      }
    }
    await this.applying_(async () => {
      if (local.deletedAt === null) {
        // Documents the server did not delete with the folder (never uploaded, or kept because they
        // were modified) stay on this device, outside the synced folder.
        for (const doc of await this.library.listDocuments()) {
          if (doc.folderId && subtree.has(doc.folderId)) await this.library.updateMeta(doc.id, { folderId: null, remote: null });
        }
        await this.library.trashFolder(info.id);
      }
      for (const id of subtree) if (view.byId.get(id)?.remote) await this.library.setFolderRemote(id, null);
    });
    changed.add(info.id);
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
    const view = await this.view();
    let local = await this.findLocal(info.id);
    if (local && !this.belongs(local, view)) return; // Same id elsewhere: never touch unrelated documents.

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
          folderId: this.localFolderOf(full.folder_id, view),
          remote: this.remoteRef(full),
          reason: 'sync',
        });
        await this.library.putSyncBase({ documentId: full.id, hash: full.content_hash, text: full.content });
      });
      changed.add(info.id);
      return;
    }

    // Name/location agreed before this change: compare before the content step moves the base.
    const base = this.metaBase(local);
    const remote = local.remote;
    if (remote?.baseRevisionId !== info.head_revision_id && remote?.conflict?.revisionId !== info.head_revision_id) {
      const full = await this.api.getDocument(info.id);
      if (local.deletedAt !== null) {
        // Someone edited a document we deleted locally: keep their edit, undo our delete.
        await this.applying_(() => this.library.restore(info.id));
        local = await this.library.getDocument(info.id);
      }
      await this.integrate(local, full);
      changed.add(info.id);
    }
    await this.applyRemoteMeta(info.id, info, base, changed);
  }

  /** Takes the server's file name and folder for fields the server changed relative to `base`. */
  private async applyRemoteMeta(id: string, info: DocumentInfo, base: { name: string; folder: string | null }, changed: Set<string>): Promise<void> {
    const doc = await this.library.getDocument(id);
    if (doc.deletedAt !== null || !doc.remote) return;
    const view = await this.view();
    const patch: MetaPatch = { remote: { ...doc.remote, baseFileName: info.file_name, baseFolderId: info.folder_id } };
    if (info.file_name !== base.name && info.file_name !== doc.fileName) patch.fileName = info.file_name;
    const target = this.localFolderOf(info.folder_id, view);
    // A document moved out of the synced folder here stays where the user put it.
    if (info.folder_id !== base.folder && target !== doc.folderId && this.serverFolderOf(doc.folderId, view) !== undefined) patch.folderId = target;
    await this.applying_(() => this.library.updateMeta(id, patch));
    if (patch.fileName !== undefined || patch.folderId !== undefined) changed.add(id);
  }

  /** Brings a newer server version into a local document (fast-forward, merge, or conflict). */
  private async integrate(local: DocumentMeta, theirs: DocumentWithContent): Promise<void> {
    const { text: ours, version } = await this.library.readContent(local.id);
    const ref = this.remoteRef(theirs, local.remote);
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
    await this.pushFolders(changed);
    let view = await this.view();
    for (const doc of await this.syncedDocuments(view)) {
      if (doc.remote?.conflict) continue;
      if (this.isPending(doc)) {
        if (doc.deletedAt !== null) {
          await this.pushDelete(doc);
          continue;
        }
        if (!doc.remote?.baseRevisionId) await this.pushCreate(doc, view, changed);
        else await this.pushUpdate(doc, changed, 0);
      }
      const current = await this.findLocal(doc.id);
      if (current && this.isMetaPending(current, view)) {
        await this.pushMeta(current, view, changed);
        view = await this.view();
      }
    }
    await this.pushFolderDeletions();
  }

  /** Creates and renames/moves folders, parents before children. */
  private async pushFolders(changed: Set<string>): Promise<void> {
    const attempted = new Set<string>();
    for (;;) {
      const view = await this.view();
      const next = [...view.byId.values()].find((f) => {
        if (f.deletedAt !== null || attempted.has(f.id) || !this.isFolderPending(f, view)) return false;
        // The parent must exist on the server first.
        const parent = f.parentId === null ? undefined : view.byId.get(f.parentId);
        return f.parentId === this.connection.folderId || Boolean(parent?.remote);
      });
      if (!next) return;
      attempted.add(next.id);
      const parent = this.serverFolderOf(next.parentId, view) ?? null;
      if (!next.remote) {
        const info = await this.api.createFolder(this.connection.libraryId, { id: next.id, parent_id: parent, name: next.name });
        if (info.id !== next.id) {
          // The server already had this folder (created on another device): adopt its id.
          await this.applying_(() => this.library.rekeyFolder(next.id, info.id, this.folderRemote(info)));
          attempted.add(info.id);
          changed.add(info.id);
        } else {
          await this.applyRemoteFolder(info, changed, { name: next.name, parentId: parent });
        }
        continue;
      }
      try {
        const info = await this.api.updateFolder(next.id, { base_name: next.remote.baseName, base_parent_id: next.remote.baseParentId, name: next.name, parent_id: parent });
        await this.applyRemoteFolder(info, changed, { name: next.name, parentId: parent });
      } catch (error) {
        // Deleted on the server meanwhile: the next pull brings the deletion.
        if (!(error instanceof SyncHttpError && error.code === 'folder.not_found')) throw error;
      }
    }
  }

  private isFolderPending(folder: Folder, view: FolderView): boolean {
    if (folder.remote && !this.ownsRemote(folder.remote)) return false;
    if (folder.deletedAt !== null) return Boolean(folder.remote);
    if (!view.tree.has(folder.id)) return false;
    if (!folder.remote) return true;
    return folder.name !== folder.remote.baseName || this.serverFolderOf(folder.parentId, view) !== folder.remote.baseParentId;
  }

  private async pushFolderDeletions(): Promise<void> {
    for (const folder of (await this.view()).byId.values()) {
      if (folder.deletedAt === null || !folder.remote || !this.ownsRemote(folder.remote)) continue;
      try {
        await this.api.deleteFolder(folder.id);
      } catch (error) {
        if (!(error instanceof SyncHttpError && error.code === 'folder.not_found')) throw error;
      }
      await this.applying_(() => this.library.setFolderRemote(folder.id, null));
    }
  }

  private async pushMeta(doc: DocumentMeta, view: FolderView, changed: Set<string>): Promise<void> {
    const base = this.metaBase(doc);
    // Outside the synced folder the server location stays as it is (null would mean the root).
    const here = this.serverFolderOf(doc.folderId, view);
    const location = here === undefined ? base.folder : here;
    let info: DocumentInfo;
    try {
      info = await this.api.updateDocumentMeta(doc.id, { base_file_name: base.name, base_folder_id: base.folder, file_name: doc.fileName, folder_id: location });
    } catch (error) {
      // Deleted on the server meanwhile: the next pull brings the deletion.
      if (error instanceof SyncHttpError && error.code === 'document.not_found') return;
      throw error;
    }
    // Fields the server refused (changed there first) take the server value here.
    await this.applyRemoteMeta(doc.id, info, { name: doc.fileName, folder: location }, changed);
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

  private async pushCreate(doc: DocumentMeta, view: FolderView, changed: Set<string>): Promise<void> {
    const { text, version } = await this.library.readContent(doc.id);
    const opId = await operationId('create', doc.id, version);
    let info: DocumentInfo;
    try {
      const folderId = this.serverFolderOf(doc.folderId, view) ?? null;
      info = await this.api.createDocument(this.connection.libraryId, { id: doc.id, file_name: doc.fileName, content: text, folder_id: folderId }, opId);
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
        await this.library.updateMeta(doc.id, { remote: this.remoteRef(info, doc.remote) });
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
  private operation<T>(action: () => Promise<T>): Promise<T> {
    if (this.retired) return Promise.reject(new AppError('auth.required'));
    const work = action();
    this.operations.add(work);
    return work.then((value) => { this.operations.delete(work); return value; },
      (error: unknown) => { this.operations.delete(work); throw error; });
  }

  async keepMine(id: string): Promise<void> {
    return this.operation(async () => {
      const doc = await this.library.getDocument(id);
      const conflict = doc.remote?.conflict;
      if (!doc.remote || !conflict) return;
      const theirs = await this.api.getDocument(id);
      await this.applying_(async () => {
        await this.library.updateMeta(id, { remote: { ...this.remoteRef(theirs, doc.remote), conflict: null } });
        await this.library.putSyncBase({ documentId: id, hash: theirs.content_hash, text: theirs.content });
      });
      await this.syncNow();
    });
  }

  /** Replace the local text with the server version (the local text stays in local history). */
  async useServer(id: string): Promise<void> {
    return this.operation(() => this.useServer_(id));
  }

  private async useServer_(id: string): Promise<void> {
    const doc = await this.library.getDocument(id);
    if (!doc.remote?.conflict) return;
    const theirs = await this.api.getDocument(id);
    const { version } = await this.library.readContent(id);
    await this.applying_(async () => {
      await this.library.saveContent(id, theirs.content, version, 'sync');
      await this.library.updateMeta(id, { remote: this.remoteRef(theirs, doc.remote) });
      await this.library.putSyncBase({ documentId: id, hash: theirs.content_hash, text: theirs.content });
    });
    this.options.onRemoteChange?.([id]);
    await this.syncNow();
  }

  /** Keep both: the server version replaces this document, the local text moves to a local-only copy. */
  async keepBoth(id: string, copySuffix: string): Promise<string> {
    return this.operation(async () => {
      const doc = await this.library.getDocument(id);
      const { text } = await this.library.readContent(id);
      const copy = await this.applying_(() =>
        this.library.createDocument({ text, fileName: doc.fileName.replace(/(\.[^.]+)?$/, ` (${copySuffix})$1`), bom: doc.bom, tags: doc.tags }),
      );
      await this.useServer_(id);
      return copy.id;
    });
  }

  /** Server version of a conflicted document, for showing a diff. */
  async serverText(id: string): Promise<string> {
    return this.operation(async () => (await this.api.getDocument(id)).content);
  }
}
