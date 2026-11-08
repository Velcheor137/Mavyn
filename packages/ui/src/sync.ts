import { toAppError, type ErrorCode } from '@mdr/core';
import { SYNC_CONNECTION_KEY, SyncEngine, toSyncAppError, type LibraryInfo, type SyncConnection, type SyncState, type UserInfo } from '@mdr/sync-client';
import { create } from 'zustand';
import type { AppServices } from './services.tsx';
import { flushAll, getSession, notify, refreshLibrary, reloadDocument } from './workspace.ts';

interface SyncStore {
  /** null while checking; false when no server serves this origin. */
  available: boolean | null;
  /** The server has no users yet: the first administrator must be created. */
  needsSetup: boolean;
  user: UserInfo | null;
  connection: SyncConnection | null;
  state: SyncState | null;
  libraries: LibraryInfo[];
  busy: boolean;
  error: ErrorCode | null;
}

export const useSync = create<SyncStore>(() => ({
  available: null,
  needsSetup: false,
  user: null,
  connection: null,
  state: null,
  libraries: [],
  busy: false,
  error: null,
}));

let services: AppServices | null = null;
let engine: SyncEngine | null = null;
let generation = 0;
let removeListeners: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function server() {
  const s = services?.server;
  if (!s) throw new Error('no server configured');
  return s;
}

async function onRemoteChange(ids: string[]): Promise<void> {
  await refreshLibrary();
  for (const id of ids) {
    const session = getSession(id);
    // Unsaved local edits stay in the editor; the conflict banner handles a diverged save.
    if (session && session.saveState.kind === 'saved') await reloadDocument(id);
  }
}

function startEngine(connection: SyncConnection): void {
  engine?.stop();
  const { library } = services!;
  engine = new SyncEngine(library, server().api, connection, {
    saveConnection: async (c) => {
      await library.putSetting(SYNC_CONNECTION_KEY, c);
      useSync.setState({ connection: c });
    },
    onState: (state) => useSync.setState({ state }),
    onRemoteChange: (ids) => void onRemoteChange(ids),
    beforeSync: flushAll,
  });
  useSync.setState({ connection });
  engine.start();
}

function ownsConnection(saved: SyncConnection | null | undefined, user: UserInfo): saved is SyncConnection {
  const baseUrl = server().baseUrl;
  return Boolean(saved && saved.userId === user.id && saved.baseUrl === baseUrl && saved.serverId === `${baseUrl}|${user.id}`);
}

/** Restores a session and mapping only for the configured server and signed-in identity. */
export async function initSync(appServices: AppServices): Promise<void> {
  const current = ++generation;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  await engine?.stopAndWait();
  if (current !== generation) return;
  engine = null;
  removeListeners?.();
  removeListeners = null;
  services = appServices;
  useSync.setState({ available: null, needsSetup: false, user: null, connection: null, state: null, libraries: [], error: null, busy: true });
  try {
    if (!appServices.server) {
      useSync.setState({ available: false });
      return;
    }
    const available = await appServices.server.health();
    if (current !== generation) return;
    useSync.setState({ available });
    if (!available) {
      if (appServices.configureServer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (current === generation) void initSync(appServices).catch((error: unknown) => useSync.setState({ error: toSyncAppError(error).code }));
        }, 15000);
      }
      return;
    }
    const online = () => engine?.schedule(0);
    const visible = () => {
      if (document.visibilityState === 'visible') engine?.schedule(0);
    };
    globalThis.addEventListener?.('online', online);
    globalThis.document?.addEventListener('visibilitychange', visible);
    removeListeners = () => {
      globalThis.removeEventListener?.('online', online);
      globalThis.document?.removeEventListener('visibilitychange', visible);
    };
    const needsSetup = await appServices.server.api.needsSetup();
    if (current !== generation) return;
    if (needsSetup) {
      useSync.setState({ needsSetup: true });
      return;
    }
    const user = await appServices.server.api.me();
    if (current !== generation) return;
    useSync.setState({ user });
    const saved = await appServices.library.getSetting<SyncConnection>(SYNC_CONNECTION_KEY);
    // A connection belongs to one account; never sync another user's copies.
    if (current !== generation) return;
    if (ownsConnection(saved, user)) startEngine(saved);
    else await loadLibraries();
  } catch (error) {
    if (current === generation && toSyncAppError(error).code !== 'auth.required') useSync.setState({ error: toSyncAppError(error).code });
  } finally { if (current === generation) useSync.setState({ busy: false }); }
}

export async function configureSyncServer(url: string): Promise<void> {
  if (!services?.configureServer || useSync.getState().user || useSync.getState().busy) return;
  useSync.setState({ busy: true, error: null });
  try {
    const configured = await services.configureServer(url);
    if (configured) services.server = configured;
    else delete services.server;
    await initSync(services);
  } catch (error) { useSync.setState({ error: toSyncAppError(error).code }); }
  finally { useSync.setState({ busy: false }); }
}

async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  useSync.setState({ busy: true, error: null });
  try {
    return await fn();
  } catch (error) {
    useSync.setState({ error: toSyncAppError(error).code });
    return undefined;
  } finally {
    useSync.setState({ busy: false });
  }
}

/** Creates the first administrator (one-time token from the server log) and signs in. */
export function completeSetup(token: string, username: string, password: string): Promise<boolean> {
  return run(async () => {
    try {
      await server().api.setup(token, username, password);
    } catch (error) {
      // Someone else finished setup meanwhile: fall back to the normal sign-in form.
      if (toSyncAppError(error).code === 'setup.already_completed') useSync.setState({ needsSetup: false });
      throw error;
    }
    useSync.setState({ needsSetup: false });
    const user = await server().api.login(username, password);
    useSync.setState({ user });
    await loadLibraries();
    return true;
  }).then((ok) => ok === true);
}

export function signIn(username: string, password: string): Promise<void> {
  return run(async () => {
    const user = await server().api.login(username, password);
    useSync.setState({ user });
    const saved = await services!.library.getSetting<SyncConnection>(SYNC_CONNECTION_KEY);
    if (ownsConnection(saved, user)) startEngine(saved);
    else await loadLibraries();
  }) as Promise<void>;
}

export async function loadLibraries(): Promise<void> {
  const libraries = await server().api.listLibraries();
  useSync.setState({ libraries });
}

/** Starts syncing a server library (existing id or a new one by name) into a local folder of that name. */
export function connectLibrary(choice: { libraryId: string } | { newName: string }): Promise<void> {
  return run(async () => {
    const { user } = useSync.getState();
    if (!user) return;
    const api = server().api;
    const library = 'newName' in choice ? await api.createLibrary(choice.newName) : useSync.getState().libraries.find((l) => l.id === choice.libraryId);
    if (!library) return;
    const local = services!.library;
    const folders = await local.listFolders();
    const folder = folders.find((f) => f.parentId === null && f.name === library.name) ?? (await local.createFolder(library.name));
    const connection: SyncConnection = {
      serverId: `${server().baseUrl}|${user.id}`,
      baseUrl: server().baseUrl,
      userId: user.id,
      username: user.username,
      libraryId: library.id,
      libraryName: library.name,
      folderId: folder.id,
      cursor: '',
    };
    await local.putSetting(SYNC_CONNECTION_KEY, connection);
    await refreshLibrary();
    startEngine(connection);
  }) as Promise<void>;
}

export function syncNow(): Promise<void> {
  return engine?.syncNow() ?? Promise.resolve();
}

/**
 * Signs out. Synced copies are either removed from this device (shared computers) or kept as
 * ordinary local documents. Documents with changes that were never uploaded are always kept.
 */
export function signOut(removeCopies: boolean): Promise<void> {
  return run(async () => {
    const connection = useSync.getState().connection;
    await engine?.stopAndWait();
    engine = null;
    const local = services!.library;
    if (connection) {
      for (const doc of await local.listDocuments({ includeTrashed: true })) {
        if (doc.remote?.serverId !== connection.serverId) continue;
        const pending = doc.deletedAt === null && (doc.remote.conflict !== null || doc.contentHash !== doc.remote.baseHash);
        await local.updateMeta(doc.id, { remote: null, ...(pending ? { folderId: null } : {}) });
        await local.deleteSyncBase(doc.id);
        if (removeCopies && !pending) {
          if (doc.deletedAt === null) await local.trash(doc.id);
          await local.purge(doc.id);
        }
      }
      await local.putSetting(SYNC_CONNECTION_KEY, null);
    }
    try {
      await server().api.logout();
    } catch (error) {
      // The local sign-out already happened; an expired session is fine.
      if (toAppError(error).code !== 'auth.required') console.warn('logout failed', error);
    }
    useSync.setState({ user: null, connection: null, state: null, libraries: [] });
    await refreshLibrary();
  }) as Promise<void>;
}

export async function resolveConflict(id: string, resolution: 'mine' | 'server' | 'both', copySuffix: string): Promise<void> {
  if (!engine) return;
  try {
    await flushAll();
    if (resolution === 'mine') await engine.keepMine(id);
    else if (resolution === 'server') await engine.useServer(id);
    else await engine.keepBoth(id, copySuffix);
    await refreshLibrary();
    await reloadDocument(id);
  } catch (error) {
    notify(`errors.${toSyncAppError(error).code}`, 'error');
  }
}

export function serverText(id: string): Promise<string> {
  if (!engine) return Promise.reject(new Error('not connected'));
  return engine.serverText(id);
}

/** For tests. */
export function resetSyncForTests(): void {
  generation++;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  removeListeners?.();
  removeListeners = null;
  engine?.stop();
  engine = null;
  services = null;
  useSync.setState({ available: null, needsSetup: false, user: null, connection: null, state: null, libraries: [], busy: false, error: null });
}
