import 'katex/dist/katex.min.css';
import '@mdr/ui/styles.css';
import { createI18n, detectLocale, I18nextProvider } from '@mdr/i18n';
import { WebPlatformAdapter } from '@mdr/platform';
import { adoptLegacyLibrary, IndexedDbBackend, Library, MemoryBackend, type Backend } from '@mdr/storage';
import { HttpSyncApi } from '@mdr/sync-client';
import { AppShell, AuthGate, initSync, initWorkspace, ServicesProvider, usePreferences, type AppServices, type AuthenticatedUser } from '@mdr/ui';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHandleStore } from './handles.ts';
import { forgetIdentity, loadIdentity, rememberIdentity } from './identity.ts';
import { createRenderer } from './renderer.ts';

declare const __APP_VERSION__: string;

/** The pre-authentication web builds kept one shared library per browser under this name. */
const LEGACY_DB = 'mdreader:local';

/**
 * `VITE_MAVYN_LOCAL_ONLY=1` builds a purely local web app (no server, no sign-in). Every other
 * build is served by a Mavyn server and requires an account before anything is shown.
 */
const LOCAL_ONLY = import.meta.env.VITE_MAVYN_LOCAL_ONLY === '1';

async function openBackend(name: string): Promise<Backend> {
  try {
    return await IndexedDbBackend.open(name);
  } catch (error) {
    // Private browsing modes may block IndexedDB: keep the app usable, nothing persists.
    console.warn('IndexedDB unavailable, using in-memory storage', error);
    return new MemoryBackend();
  }
}

async function legacyDatabaseExists(): Promise<boolean> {
  if (!indexedDB.databases) return true; // Cannot tell; opening an empty one is harmless.
  return (await indexedDB.databases()).some((db) => db.name === LEGACY_DB);
}

/** One database per account on this origin, so people sharing a browser never see each other's documents. */
async function openAccountBackend(user: AuthenticatedUser): Promise<Backend> {
  const backend = await openBackend(`mdreader:${location.origin}:${user.id}`);
  if (await legacyDatabaseExists()) {
    const legacy = await openBackend(LEGACY_DB);
    try {
      await adoptLegacyLibrary(legacy, backend);
    } finally {
      legacy.close();
    }
    // Adopted (or empty): remove it so a second account on this browser cannot take it over.
    indexedDB.deleteDatabase(LEGACY_DB);
  }
  return backend;
}

async function boot(): Promise<void> {
  const locale = usePreferences.getState().locale ?? detectLocale(navigator.languages ?? [navigator.language]);
  document.documentElement.lang = locale;
  const i18n = createI18n(locale);
  const root = createRoot(document.getElementById('root')!);
  const show = (node: ReactNode) =>
    root.render(
      <StrictMode>
        <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
      </StrictMode>,
    );

  // Linked-file handles are optional: a browser whose IndexedDB never answers must still show the app.
  const noHandles = { get: async () => undefined, put: async () => {} };
  const handles = await Promise.race([
    createHandleStore().catch(() => noHandles),
    new Promise<typeof noHandles>((resolve) => setTimeout(() => resolve(noHandles), 3000)),
  ]);
  const base = {
    platform: new WebPlatformAdapter(handles),
    i18n,
    renderMarkdown: createRenderer(),
    appVersion: __APP_VERSION__,
  };

  const start = async (services: AppServices) => {
    show(
      <ServicesProvider services={services}>
        <AppShell />
      </ServicesProvider>,
    );
    await initWorkspace(services);
    await initSync(services);
  };

  if (LOCAL_ONLY) {
    await start({ ...base, library: new Library(await openBackend(LEGACY_DB)) });
  } else {
    // The web app talks only to the server it is served from (cookie session, no CORS).
    const api = new HttpSyncApi(location.origin);
    const health = () => api.health();
    let started = false;
    const onAuthenticated = (user: AuthenticatedUser, offline: boolean) => {
      if (started) return;
      started = true;
      rememberIdentity(location.origin, user);
      void (async () => {
        const services: AppServices = {
          ...base,
          library: new Library(await openAccountBackend(user)),
          server: { baseUrl: location.origin, api, health },
          onSignedOut: () => {
            forgetIdentity();
            location.reload();
          },
        };
        await start(services);
        // Started offline: connect sync as soon as the network returns.
        if (offline) window.addEventListener('online', () => void initSync(services), { once: true });
      })();
    };
    show(<AuthGate api={api} health={health} remembered={loadIdentity(location.origin)} onAuthenticated={onAuthenticated} />);
  }

  if (navigator.storage?.persist) void navigator.storage.persist();
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => console.warn('service worker registration failed', error));
  }
}

void boot();
