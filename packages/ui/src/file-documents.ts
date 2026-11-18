import { AppError, sha256Hex, toAppError, type DocumentMeta } from '@mdr/core';
import { serverOriginal } from './sync.ts';
import type { SessionSaveState } from '@mdr/core';
import { notify, notifyError, openDocument, refreshLibrary, registerFlusher, svcForFiles, translateForFiles } from './workspace.ts';

/**
 * Binary documents (docx, xlsx, ods; pdf is view-only) edited inside Mavyn. No history: a save
 * replaces the bytes. A linked file is written first (compare-and-swap on its fingerprint), like
 * text. Content the editor cannot keep makes the first edit go to a copy (`forkForEditing`).
 */

/** Saves edited bytes if the stored version is still `baseVersion`; returns the new version. */
export async function saveFileDocument(id: string, bytes: Uint8Array, baseVersion: string): Promise<string> {
  const { library, platform } = svcForFiles();
  const meta = await library.getDocument(id);
  if (meta.source.kind === 'linked') {
    if (!meta.source.fingerprint) throw new AppError('file.external_change', { id });
    const fingerprint = await platform.writeLinked(meta.source.locator, bytes, meta.source.fingerprint);
    const version = await library.saveFile(id, bytes, baseVersion);
    await library.updateMeta(id, { source: { ...meta.source, fingerprint } });
    void refreshLibrary();
    return version;
  }
  const version = await library.saveFile(id, bytes, baseVersion);
  void refreshLibrary();
  return version;
}

/**
 * Brings a linked binary document and its file on disk together before showing it: disk changed →
 * disk wins (an edit made only here is kept as a copy first); only the library changed (a synced
 * edit) → the file is updated. Returns the current version.
 */
export async function reconcileLinkedFile(meta: DocumentMeta): Promise<void> {
  if (meta.source.kind !== 'linked') return;
  const { library, platform } = svcForFiles();
  try {
    const disk = await platform.readLinked(meta.source.locator);
    const known = meta.source.fingerprint?.contentHash ?? null;
    let fingerprint = disk.fingerprint;
    if (disk.fingerprint.contentHash !== meta.contentHash) {
      if (known !== null && disk.fingerprint.contentHash === known) {
        const { bytes } = await library.readFile(meta.id);
        fingerprint = await platform.writeLinked(meta.source.locator, bytes, disk.fingerprint);
      } else {
        if (known !== null && meta.contentHash !== known) {
          const copy = await copyOf(meta, translateForFiles('conflict.copySuffix'), (await library.readFile(meta.id)).bytes);
          notify('conflict.keptCopy', 'info', { title: copy.title });
        }
        await library.saveFile(meta.id, disk.bytes, meta.contentHash);
      }
    }
    await library.updateMeta(meta.id, { source: { ...meta.source, fingerprint } });
    await refreshLibrary();
  } catch (error) {
    notifyError(error);
  }
}

async function copyOf(meta: DocumentMeta, suffix: string, bytes: Uint8Array, originalBytes?: Uint8Array): Promise<DocumentMeta> {
  const { library } = svcForFiles();
  const fileName = meta.fileName.replace(/(\.[^.]+)?$/, ` (${suffix})$1`);
  return library.createFileDocument({
    bytes,
    ...(originalBytes ? { originalBytes } : {}),
    fileName,
    mime: meta.mime ?? 'application/octet-stream',
    folderId: meta.folderId,
    tags: meta.tags,
  });
}

/**
 * The first edit of a file with content Mavyn cannot save (charts, macros, pivot tables, complex
 * layout) goes to a copy next to it; the original stays untouched. Returns the copy's id.
 */
export async function forkForEditing(id: string, reasons: string[]): Promise<string> {
  const { library } = svcForFiles();
  const { bytes, meta } = await library.readFile(id);
  const copy = await copyOf(meta, translateForFiles('files.editedSuffix'), bytes);
  await refreshLibrary();
  await openDocument(copy.id);
  notify('files.forked', 'info', { title: copy.title, reasons: reasons.map((r) => translateForFiles(`files.reason_${r}`)).join(', ') });
  return copy.id;
}

/** "Restore original": the bytes the document was imported with open as a copy next to it. */
export async function restoreOriginal(id: string): Promise<void> {
  const { library } = svcForFiles();
  try {
    const meta = await library.getDocument(id);
    let bytes: Uint8Array;
    try {
      bytes = (await library.readOriginal(id)).bytes;
    } catch (error) {
      // Synced before originals were kept here: ask the server.
      if (!meta.remote || toAppError(error).code !== 'storage.failed') throw error;
      bytes = await serverOriginal(id);
      if (meta.originalHash && (await sha256Hex(bytes)) !== meta.originalHash) throw new AppError('server.unavailable', { reason: 'file_hash' });
    }
    const copy = await copyOf(meta, translateForFiles('files.originalSuffix'), bytes);
    await refreshLibrary();
    await openDocument(copy.id);
  } catch (error) {
    notifyError(error);
  }
}

/** Whether the document has an original that differs from its current bytes. */
export function hasDistinctOriginal(meta: DocumentMeta): boolean {
  return meta.kind === 'file' && meta.originalHash !== undefined && meta.originalHash !== meta.contentHash;
}

/**
 * Autosave of an edited binary document: written after 3 s without changes, at least every 30 s
 * while editing, and on flush (tab switch, app hidden). Every write replaces the whole file (up to
 * 50 MiB), so it is not done on every keystroke.
 */
export class FileAutosaver {
  private serialize: (() => Promise<Uint8Array>) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPending = 0;
  private running: Promise<void> = Promise.resolve();
  private readonly unregister: () => void;

  constructor(
    private readonly id: string,
    private version: string,
    private readonly onState: (state: SessionSaveState, version?: string) => void,
    private readonly idleMs = 3000,
    private readonly maxMs = 30_000,
  ) {
    this.unregister = registerFlusher(() => this.flush());
  }

  schedule(serialize: () => Promise<Uint8Array>): void {
    this.serialize = serialize;
    const now = Date.now();
    if (!this.firstPending) this.firstPending = now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.idleMs, this.maxMs - (now - this.firstPending)));
    this.timer = setTimeout(() => void this.flush(), wait);
    this.onState({ kind: 'dirty' });
  }

  flush(): Promise<void> {
    this.running = this.running.then(() => this.save());
    return this.running;
  }

  private async save(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const serialize = this.serialize;
    if (!serialize) return;
    this.serialize = null;
    this.firstPending = 0;
    this.onState({ kind: 'saving' });
    let bytes: Uint8Array | null = null;
    try {
      bytes = await serialize();
      // Announced before the write so the view knows the coming change is its own (no reload).
      this.onState({ kind: 'saving' }, await sha256Hex(bytes));
      this.version = await saveFileDocument(this.id, bytes, this.version);
      this.onState({ kind: 'saved', at: Date.now() }, this.version);
    } catch (error) {
      const code = toAppError(error).code;
      if (code === 'file.external_change' && bytes) {
        // Changed meanwhile (another device, the file on disk): never overwrite; keep these edits.
        const { library } = svcForFiles();
        const meta = await library.getDocument(this.id);
        const copy = await copyOf(meta, translateForFiles('conflict.copySuffix'), bytes);
        await refreshLibrary();
        notify('conflict.keptCopy', 'info', { title: copy.title });
        this.onState({ kind: 'conflict' });
      } else {
        notifyError(error);
        this.onState({ kind: 'error', code });
      }
    }
  }

  dispose(): Promise<void> {
    const done = this.flush();
    this.unregister();
    return done;
  }
}

/**
 * First edit of a file with content Mavyn cannot save: the edited bytes go to a copy (whose
 * original of import is this document's), which then opens; this document stays untouched.
 */
export async function forkWithEdits(id: string, bytes: Uint8Array, reasons: string[]): Promise<void> {
  const { library } = svcForFiles();
  try {
    const meta = await library.getDocument(id);
    const original = await library.readOriginal(id).then((o) => o.bytes, () => undefined);
    const copy = await copyOf(meta, translateForFiles('files.editedSuffix'), bytes, original);
    await refreshLibrary();
    await openDocument(copy.id);
    notify('files.forked', 'info', { title: copy.title, reasons: reasons.map((r) => translateForFiles(`files.reason_${r}`)).join(', ') });
  } catch (error) {
    notifyError(error);
  }
}
