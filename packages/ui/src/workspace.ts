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
  const { tabs, active, viewModes, positions } = useWorkspace.getState();
  saveWorkspaceSnapshot({ tabs, active, viewModes, positions });
}

export function getSession(id: string): DocumentSession | undefined {
  return sessions.get(id);
}

export function notify(message: string, kind: Toast['kind'] = 'info', values?: Toast['values']): void {
  const toast: Toast = { id: ++toastSeq, kind, message, ...(values ? { values } : {}) };
  useWorkspace.setState((s) => ({ toasts: [...s.toasts, toast] }));
  setTimeout(() => dismissToast(toast.id), kind === 'error' ? 8000 : 4000);
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
  const known = new Set(useWorkspace.getState().documents.map((d) => d.id));
  const tabs = snapshot.tabs.filter((id) => known.has(id));
  useWorkspace.setState({
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

export async function createDocument(title: string): Promise<void> {
  const { library } = svc();
  const meta = await library.createDocument({ text: `# ${title}\n\n`, fileName: `${title}.md` });
  await refreshLibrary();
  useWorkspace.setState((s) => ({ viewModes: { ...s.viewModes, [meta.id]: 'split' } }));
  await openDocument(meta.id);
}

/** Adds picked/dropped files. Linked files keep a locator for in-place saving. */
export async function addFiles(files: PickedFile[]): Promise<void> {
  const { library } = svc();
  let lastId: string | null = null;
  for (const file of files) {
    try {
      const decoded = decodeUtf8(file.bytes);
      const source = file.locator && file.fingerprint ? ({ kind: 'linked', locator: file.locator, fingerprint: file.fingerprint } as const) : undefined;
      const meta = await library.createDocument({ text: decoded.text, bom: decoded.bom, fileName: file.name, ...(source ? { source } : {}) });
      lastId = meta.id;
    } catch (error) {
      notifyError(error);
    }
  }
  await refreshLibrary();
  if (lastId) await openDocument(lastId);
}

export async function updateDocument(id: string, patch: Parameters<AppServices['library']['updateMeta']>[1]): Promise<void> {
  try {
    await svc().library.updateMeta(id, patch);
    await refreshLibrary();
  } catch (error) {
    notifyError(error);
  }
}

export async function trashDocument(id: string): Promise<void> {
  await closeTab(id);
  await svc().library.trash(id);
  await refreshLibrary();
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
