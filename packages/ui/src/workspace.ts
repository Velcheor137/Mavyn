import {
  AppError,
  decodeAs,
  DocumentSession,
  encodeDocumentText,
  encodeText,
  MAX_FILE_BYTES,
  sha256Hex,
  toAppError,
  type DocumentMeta,
  type ErrorCode,
  type Folder,
} from '@mdr/core';
import type { PickedFile } from '@mdr/platform';
import type { SearchHit } from '@mdr/storage';
import { create } from 'zustand';
import { loadWorkspaceSnapshot, saveWorkspaceSnapshot, usePreferences, type ViewMode } from './preferences.ts';
import type { AppServices } from './services.tsx';
import { importPickedFile, type Placement } from './import-files.ts';

/** Localizes text that ends up in stored data (copy names); set by the app shell with its i18n. */
let translate: (key: string) => string = (key) => key;
export function setTranslator(fn: (key: string) => string): void {
  translate = fn;
}
/** For `file-documents.ts` (kept apart to avoid an import cycle with sync). */
export function translateForFiles(key: string): string {
  return translate(key);
}

export type Section =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'recent' }
  | { kind: 'trash' }
  | { kind: 'tag'; tag: string }
  | { kind: 'folder'; folderId: string };

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  /** i18n key */
  message: string;
  values?: Record<string, string | number>;
  /** One follow-up button, e.g. "Undo". `label` is an i18n key. */
  action?: { label: string; run(): void };
}

interface WorkspaceState {
  ready: boolean;
  documents: DocumentMeta[];
  folders: Folder[];
  tabs: string[];
  active: string | null;
  viewModes: Record<string, ViewMode>;
  positions: Record<string, number>;
  section: Section;
  query: string;
  hits: SearchHit[] | null;
  toasts: Toast[];
  /** Bumped whenever a session's text or save state changes, to re-render subscribers. */
  sessionTick: number;
}

const sessions = new Map<string, DocumentSession>();
let services: AppServices | null = null;
let toastSeq = 0;

export const useWorkspace = create<WorkspaceState>(() => ({
  ready: false,
  documents: [],
  folders: [],
  tabs: [],
  active: null,
  viewModes: {},
  positions: {},
  section: { kind: 'all' },
  query: '',
  hits: null,
  toasts: [],
  sessionTick: 0,
}));

function svc(): AppServices {
  if (!services) throw new Error('workspace not initialised');
  return services;
}

/** For `file-documents.ts`. */
export function svcForFiles(): AppServices {
  return svc();
}

function persist(): void {
  const { tabs, active, viewModes, positions, section } = useWorkspace.getState();
  saveWorkspaceSnapshot({ tabs, active, viewModes, positions, section });
}

/** Opens a sidebar section (folder, tag, …) and remembers it for the next start. */
export function setSection(section: Section): void {
  useWorkspace.setState({ section });
  persist();
}

/** A remembered section is kept only while its folder or tag still exists. */
function restoredSection(saved: unknown, documents: DocumentMeta[], folders: Folder[]): Section {
  const section = saved as Partial<Section> | null;
  switch (section?.kind) {
    case 'favorites':
    case 'recent':
    case 'trash':
      return { kind: section.kind };
    case 'folder':
      return folders.some((f) => f.id === section.folderId) ? { kind: 'folder', folderId: section.folderId! } : { kind: 'all' };
    case 'tag':
      return documents.some((d) => d.deletedAt === null && d.tags.includes(section.tag!)) ? { kind: 'tag', tag: section.tag! } : { kind: 'all' };
    default:
      return { kind: 'all' };
  }
}

/** Where new and opened documents go: the open folder (so they show up there) and the open tag. */
function currentPlacement(): Placement {
  const { section, folders } = useWorkspace.getState();
  return {
    folderId: section.kind === 'folder' && folders.some((f) => f.id === section.folderId) ? section.folderId : null,
    tags: section.kind === 'tag' ? [section.tag] : [],
  };
}

/** View-only binary documents have no editing session. */
function isFileId(id: string): boolean {
  return useWorkspace.getState().documents.find((d) => d.id === id)?.kind === 'file';
}

/** Prepares a tab for display: an editing session for text, nothing for binary documents. */
async function prepareTab(id: string): Promise<void> {
  if (isFileId(id)) {
    void svc().library.updateMeta(id, { openedAt: new Date().toISOString() }).then(refreshLibrary).catch(notifyError);
    return;
  }
  await ensureSession(id);
}

export function getSession(id: string): DocumentSession | undefined {
  return sessions.get(id);
}

export function notify(message: string, kind: Toast['kind'] = 'info', values?: Toast['values'], action?: Toast['action']): void {
  const toast: Toast = { id: ++toastSeq, kind, message, ...(values ? { values } : {}), ...(action ? { action } : {}) };
  useWorkspace.setState((s) => ({ toasts: [...s.toasts, toast] }));
  // Leave enough time to reach an "Undo" button.
  setTimeout(() => dismissToast(toast.id), kind === 'error' || action ? 8000 : 4000);
}

export function notifyError(error: unknown): void {
  const appError = toAppError(error);
  const code: ErrorCode = appError.code;
  if (code === 'unknown') console.error(error);
  const values: Record<string, string | number> | undefined = code === 'file.too_large'
    ? { maxMb: Math.round(Number(appError.details.maxBytes ?? MAX_FILE_BYTES) / (1024 * 1024)) }
    : code === 'file.unencodable'
      ? { encoding: String(appError.details.encoding ?? '').toUpperCase() }
      : undefined;
  notify(`errors.${code}`, 'error', values);
}

export function dismissToast(id: number): void {
  useWorkspace.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export async function initWorkspace(appServices: AppServices): Promise<void> {
  services = appServices;
  const snapshot = loadWorkspaceSnapshot();
  await refreshLibrary();
  const { documents, folders } = useWorkspace.getState();
  const known = new Set(documents.map((d) => d.id));
  const tabs = snapshot.tabs.filter((id) => known.has(id));
  useWorkspace.setState({
    section: restoredSection(snapshot.section, documents, folders),
    tabs,
    active: snapshot.active && tabs.includes(snapshot.active) ? snapshot.active : (tabs[0] ?? null),
    viewModes: snapshot.viewModes,
    positions: snapshot.positions,
    ready: true,
  });
  const { active } = useWorkspace.getState();
  if (active) await prepareTab(active).catch(notifyError);
}

export async function refreshLibrary(): Promise<void> {
  const { library } = svc();
  const [documents, folders] = await Promise.all([library.listDocuments({ includeTrashed: true }), library.listFolders()]);
  useWorkspace.setState({ documents, folders });
}

function bump(): void {
  useWorkspace.setState((s) => ({ sessionTick: s.sessionTick + 1 }));
}

/** Opens (or returns) the editing session for a document, reconciling linked files with disk. */
export async function ensureSession(id: string): Promise<DocumentSession> {
  const existing = sessions.get(id);
  if (existing) return existing;
  const { library, platform } = svc();
  let { text, version, meta } = await library.readContent(id);

  if (meta.source.kind === 'linked') {
    try {
      const disk = await platform.readLinked(meta.source.locator);
      const decoded = decodeAs(disk.bytes, meta.encoding ?? 'utf-8');
      const local = await sha256Hex(encodeDocumentText(text, meta));
      const known = meta.source.fingerprint?.contentHash ?? null;
      let fingerprint = disk.fingerprint;
      if (disk.fingerprint.contentHash !== local) {
        if (known !== null && disk.fingerprint.contentHash === known) {
          // Only the library changed while closed (e.g. a synced edit): bring the file up to date.
          fingerprint = await platform.writeLinked(meta.source.locator, encodeDocumentText(text, meta), disk.fingerprint);
        } else {
          // Changed on disk: disk wins. There is no version history, so text that also changed in
          // the library is kept as a separate copy first.
          if (known !== null && local !== known) {
            const name = meta.fileName.replace(/(\.[^.]+)?$/, ` (${translate('conflict.copySuffix')})$1`);
            const copy = await library.createDocument({ text, fileName: name, bom: meta.bom, encoding: meta.encoding, folderId: meta.folderId, tags: meta.tags });
            notify('conflict.keptCopy', 'info', { title: copy.title });
          }
          version = await library.saveContent(id, decoded.text, version);
          text = decoded.text;
        }
      }
      meta = await library.updateMeta(id, { source: { ...meta.source, fingerprint } });
    } catch (error) {
      notifyError(error);
    }
  }

  const session = new DocumentSession({
    text,
    version,
    autosaveDelayMs: usePreferences.getState().autosaveDelayMs,
    save: (next, base) => saveDocument(id, next, base),
  });
  session.subscribe(bump);
  sessions.set(id, session);
  void library.updateMeta(id, { openedAt: new Date().toISOString() }).then(refreshLibrary);
  return session;
}

async function saveDocument(id: string, text: string, baseVersion: string): Promise<string> {
  const { library, platform } = svc();
  const meta = await library.getDocument(id);
  if (meta.source.kind === 'linked') {
    if (!meta.source.fingerprint) throw new AppError('file.external_change', { id });
    // The original file is authoritative: write it first (compare-and-swap on its fingerprint).
    const fingerprint = await platform.writeLinked(meta.source.locator, encodeDocumentText(text, meta), meta.source.fingerprint);
    const version = await library.saveContent(id, text, baseVersion);
    await library.updateMeta(id, { source: { ...meta.source, fingerprint } });
    void refreshLibrary();
    return version;
  }
  const version = await library.saveContent(id, text, baseVersion);
  void refreshLibrary();
  return version;
}

export async function openDocument(id: string): Promise<void> {
  try {
    await prepareTab(id);
  } catch (error) {
    notifyError(error);
    return;
  }
  useWorkspace.setState((s) => ({ tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id }));
  persist();
}

export async function closeTab(id: string): Promise<void> {
  const session = sessions.get(id);
  if (session) {
    await session.flush();
    if (session.saveState.kind === 'saved') {
      session.dispose();
      sessions.delete(id);
    }
  }
  useWorkspace.setState((s) => {
    const index = s.tabs.indexOf(id);
    const tabs = s.tabs.filter((t) => t !== id);
    const active = s.active === id ? (tabs[Math.min(index, tabs.length - 1)] ?? null) : s.active;
    return { tabs, active };
  });
  persist();
  const { active } = useWorkspace.getState();
  if (active) await prepareTab(active).catch(notifyError);
}

export function cycleTab(direction: 1 | -1): void {
  const { tabs, active } = useWorkspace.getState();
  if (tabs.length < 2 || !active) return;
  const next = tabs[(tabs.indexOf(active) + direction + tabs.length) % tabs.length]!;
  void openDocument(next);
}

export function setViewMode(id: string, mode: ViewMode): void {
  useWorkspace.setState((s) => ({ viewModes: { ...s.viewModes, [id]: mode } }));
  persist();
}

let positionTimer: ReturnType<typeof setTimeout> | null = null;
export function setReadingPosition(id: string, fraction: number): void {
  useWorkspace.setState((s) => ({ positions: { ...s.positions, [id]: fraction } }));
  if (positionTimer) clearTimeout(positionTimer);
  positionTimer = setTimeout(persist, 500);
}

/**
 * Creates an empty plain text or code file with the given name (any extension, or none) where the
 * user is looking. A taken name gets a number before the extension.
 */
export async function createTextFile(fileName: string): Promise<void> {
  const { library } = svc();
  const { section, documents } = useWorkspace.getState();
  const { folderId, tags } = currentPlacement();
  const trimmed = fileName.normalize('NFC').trim();
  if (!trimmed || trimmed.length > 255 || /[\\/\0]/.test(trimmed)) throw new AppError('folder.invalid_name');
  const taken = new Set(documents.filter((d) => d.deletedAt === null && d.folderId === folderId).map((d) => d.fileName.toLowerCase()));
  const dot = trimmed.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [trimmed.slice(0, dot), trimmed.slice(dot)] : [trimmed, ''];
  let name = trimmed;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} ${n}${ext}`;
  const meta = await library.createDocument({ text: '', fileName: name, folderId, tags });
  if (section.kind === 'favorites') await library.updateMeta(meta.id, { favorite: true });
  await refreshLibrary();
  await openDocument(meta.id);
}

/**
 * Creates a document where the user is looking: inside the open folder (so it is visible there
 * and, in a synced folder, uploaded), with the open tag, or as a favorite.
 */
export async function createDocument(title: string): Promise<void> {
  const { library } = svc();
  const { section, documents } = useWorkspace.getState();
  const { folderId, tags } = currentPlacement();
  // "Untitled", "Untitled 2", …: distinct names in the folder, also for exports and other devices.
  const taken = new Set(documents.filter((d) => d.deletedAt === null && d.folderId === folderId).map((d) => d.fileName.toLowerCase()));
  let name = title;
  for (let n = 2; taken.has(`${name}.md`.toLowerCase()); n++) name = `${title} ${n}`;
  const meta = await library.createDocument({
    text: `# ${name}\n\n`,
    fileName: `${name}.md`,
    folderId,
    tags,
  });
  if (section.kind === 'favorites') await library.updateMeta(meta.id, { favorite: true });
  await refreshLibrary();
  useWorkspace.setState((s) => ({ viewModes: { ...s.viewModes, [meta.id]: 'split' } }));
  await openDocument(meta.id);
}

/**
 * Adds picked/dropped files to the folder the user is looking at (like new documents), so they
 * show up where expected and, in a synced folder, reach the other devices. Linked files keep a
 * locator for in-place saving.
 */
/**
 * Where dropped files go: the open folder, unless a server library is connected and that folder is
 * outside it — then the library's root folder, so the files are uploaded.
 */
export function dropPlacement(syncRoot: string | null): Placement {
  const placement = currentPlacement();
  if (!syncRoot) return placement;
  const byId = new Map(useWorkspace.getState().folders.map((f) => [f.id, f]));
  for (let id = placement.folderId, depth = 0; id !== null && depth < 1000; depth++) {
    if (id === syncRoot) return placement;
    id = byId.get(id)?.parentId ?? null;
  }
  return { ...placement, folderId: syncRoot };
}

/**
 * Imports files into the library and opens them: the last one by default, or each in its own tab
 * (`openAll`, used for files dragged into the window).
 */
export async function addFiles(files: PickedFile[], options: { openAll?: boolean; placement?: Placement } = {}): Promise<PickedFile[]> {
  const { library } = svc();
  const placement = options.placement ?? currentPlacement();
  const opened: string[] = [];
  const saved: PickedFile[] = [];
  for (const file of files) {
    try {
      const meta = await importPickedFile(library, file, placement);
      saved.push(file);
      if (!meta.deletedAt) opened.push(meta.id);
    } catch (error) {
      notifyError(error);
    }
  }
  await refreshLibrary();
  for (const id of options.openAll ? opened : opened.slice(-1)) await openDocument(id);
  const folder = useWorkspace.getState().folders.find((f) => f.id === placement.folderId);
  if (saved.length && folder) notify('document.addedToFolder', 'info', { count: saved.length, folder: folder.name });
  return saved;
}

export async function updateDocument(id: string, patch: Parameters<AppServices['library']['updateMeta']>[1]): Promise<void> {
  try {
    await svc().library.updateMeta(id, patch);
    await refreshLibrary();
  } catch (error) {
    notifyError(error);
  }
}

/** Moves a document to Trash and offers to undo it right away. */
export async function trashDocument(id: string): Promise<void> {
  const title = useWorkspace.getState().documents.find((d) => d.id === id)?.title ?? '';
  await closeTab(id);
  await svc().library.trash(id);
  await refreshLibrary();
  notify('document.movedToTrash', 'info', { title }, {
    label: 'document.undo',
    run: () => void restoreDocument(id).then(() => openDocument(id)).catch(notifyError),
  });
}

export async function restoreDocument(id: string): Promise<void> {
  await svc().library.restore(id);
  await refreshLibrary();
}

export async function purgeDocument(id: string): Promise<void> {
  await svc().library.purge(id);
  await refreshLibrary();
}

/** Conflict resolution: load the stored version; the user's text stays reachable via undo. */
export async function reloadDocument(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  const { library, platform } = svc();
  try {
    const meta = await library.getDocument(id);
    let { text, version } = await library.readContent(id);
    if (meta.source.kind === 'linked') {
      const disk = await platform.readLinked(meta.source.locator);
      const decoded = decodeAs(disk.bytes, meta.encoding ?? 'utf-8');
      if (decoded.text !== text) version = await library.saveContent(id, decoded.text, version);
      text = decoded.text;
      await library.updateMeta(id, { source: { ...meta.source, fingerprint: disk.fingerprint } });
    }
    session.replaceFromExternal(text, version);
    await refreshLibrary();
  } catch (error) {
    notifyError(error);
  }
}

/** Whether the document's original bytes are available to decode again with another encoding. */
export function canReopenWithEncoding(meta: DocumentMeta): boolean {
  return meta.source.kind === 'linked' || Boolean(meta.importBytesHash);
}

/** Decodes the original bytes again with `encoding` (when detection guessed wrong). */
export async function reopenWithEncoding(id: string, encoding: string): Promise<void> {
  const { library, platform } = svc();
  try {
    await flushAll();
    const meta = await library.getDocument(id);
    const { version } = await library.readContent(id);
    let bytes: Uint8Array | null;
    let fingerprint = meta.source.kind === 'linked' ? meta.source.fingerprint : null;
    if (meta.source.kind === 'linked') {
      const disk = await platform.readLinked(meta.source.locator);
      bytes = disk.bytes;
      fingerprint = disk.fingerprint;
    } else {
      bytes = await library.readImportBytes(id);
    }
    if (!bytes) throw new AppError('file.unsupported', { reason: 'no_original' });
    const decoded = decodeAs(bytes, encoding);
    const next = await library.saveContent(id, decoded.text, version, { keepImportBytes: true });
    await library.updateMeta(id, {
      encoding: decoded.encoding,
      bom: decoded.bom,
      ...(meta.source.kind === 'linked' && fingerprint ? { source: { ...meta.source, fingerprint } } : {}),
    });
    sessions.get(id)?.replaceFromExternal(decoded.text, next);
    await refreshLibrary();
  } catch (error) {
    notifyError(error);
  }
}

/** Changes the encoding the document is saved in; a linked file is rewritten right away. */
export async function setSaveEncoding(id: string, encoding: string): Promise<void> {
  const { library, platform } = svc();
  try {
    await flushAll();
    const meta = await library.getDocument(id);
    const { text } = await library.readContent(id);
    // UTF-16 files always carry a BOM; legacy encodings never do; UTF-8 keeps the current choice.
    const bom = encoding.startsWith('utf-16') ? true : encoding === 'utf-8' ? meta.bom : false;
    const bytes = encodeText(text, encoding, bom); // throws `file.unencodable` before anything changes
    if (meta.source.kind === 'linked') {
      if (!meta.source.fingerprint) throw new AppError('file.external_change', { id });
      const fingerprint = await platform.writeLinked(meta.source.locator, bytes, meta.source.fingerprint);
      await library.updateMeta(id, { encoding, bom, source: { ...meta.source, fingerprint } });
    } else {
      await library.updateMeta(id, { encoding, bom });
    }
    await refreshLibrary();
  } catch (error) {
    notifyError(error);
  }
}

/** Conflict resolution: keep the user's text as a new library document. */
export async function saveAsCopy(id: string, copySuffix: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  const meta = await svc().library.getDocument(id);
  const name = meta.fileName.replace(/(\.[^.]+)?$/, ` (${copySuffix})$1`);
  const copy = await svc().library.createDocument({ text: session.text, fileName: name, bom: meta.bom, encoding: meta.encoding, folderId: meta.folderId, tags: meta.tags });
  await reloadDocument(id);
  await refreshLibrary();
  await openDocument(copy.id);
}

let searchSeq = 0;
export async function search(query: string): Promise<void> {
  useWorkspace.setState({ query });
  const seq = ++searchSeq;
  if (!query.trim()) {
    useWorkspace.setState({ hits: null });
    return;
  }
  const hits = await svc().library.search(query);
  if (seq === searchSeq) useWorkspace.setState({ hits });
}

/** Extra unsaved state (edited binary documents) flushed together with text sessions. */
const flushers = new Set<() => Promise<void>>();
export function registerFlusher(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => flushers.delete(flush);
}

export async function flushAll(): Promise<void> {
  await Promise.all([...[...sessions.values()].map((s) => s.flush()), ...[...flushers].map((f) => f())]);
}

export function applyAutosaveDelay(ms: number): void {
  for (const session of sessions.values()) session.setAutosaveDelay(ms);
}

/** For tests: forget all module-level state. */
export function resetWorkspaceForTests(): void {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
  services = null;
  useWorkspace.setState({ ready: false, documents: [], folders: [], tabs: [], active: null, viewModes: {}, positions: {}, section: { kind: 'all' }, query: '', hits: null, toasts: [] });
}
