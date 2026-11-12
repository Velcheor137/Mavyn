import {
  AppError,
  decodeUtf8,
  DocumentSession,
  encodeUtf8,
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
  const code: ErrorCode = toAppError(error).code;
  if (code === 'unknown') console.error(error);
  notify(`errors.${code}`, 'error');
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
  if (active) await ensureSession(active).catch(notifyError);
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
      const decoded = decodeUtf8(disk.bytes);
      if (disk.fingerprint.contentHash !== (await sha256Hex(encodeUtf8({ text, bom: meta.bom })))) {
        // Changed on disk while closed: disk wins, the previous text stays in history.
        version = await library.saveContent(id, decoded.text, version);
        text = decoded.text;
      }
      meta = await library.updateMeta(id, { source: { ...meta.source, fingerprint: disk.fingerprint } });
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
    const fingerprint = await platform.writeLinked(meta.source.locator, encodeUtf8({ text, bom: meta.bom }), meta.source.fingerprint);
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
    await ensureSession(id);
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
  if (active) await ensureSession(active).catch(notifyError);
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
export async function addFiles(files: PickedFile[]): Promise<PickedFile[]> {
  const { library } = svc();
  const placement = currentPlacement();
  let lastId: string | null = null;
  const saved: PickedFile[] = [];
  for (const file of files) {
    try {
      const meta = await importPickedFile(library, file, placement);
      saved.push(file);
      if (!meta.deletedAt) lastId = meta.id;
    } catch (error) {
      notifyError(error);
    }
  }
  await refreshLibrary();
  if (lastId) await openDocument(lastId);
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
      const decoded = decodeUtf8(disk.bytes);
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

/** Conflict resolution: keep the user's text as a new library document. */
export async function saveAsCopy(id: string, copySuffix: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  const meta = await svc().library.getDocument(id);
  const name = meta.fileName.replace(/(\.[^.]+)?$/, ` (${copySuffix})$1`);
  const copy = await svc().library.createDocument({ text: session.text, fileName: name, bom: meta.bom, folderId: meta.folderId, tags: meta.tags });
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

export async function flushAll(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => s.flush()));
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
