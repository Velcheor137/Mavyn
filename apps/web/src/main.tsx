import 'katex/dist/katex.min.css';
import '@mdr/ui/styles.css';
import { createI18n, detectLocale, I18nextProvider } from '@mdr/i18n';
import { WebPlatformAdapter } from '@mdr/platform';
import { IndexedDbBackend, Library, MemoryBackend, type Backend } from '@mdr/storage';
import { HttpSyncApi } from '@mdr/sync-client';
import { AppShell, initSync, initWorkspace, ServicesProvider, usePreferences, type AppServices } from '@mdr/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHandleStore } from './handles.ts';
import { createRenderer } from './renderer.ts';

declare const __APP_VERSION__: string;

async function openBackend(): Promise<Backend> {
  try {
    return await IndexedDbBackend.open('mdreader:local');
  } catch (error) {
    // Private browsing modes may block IndexedDB: keep the app usable, nothing persists.
    console.warn('IndexedDB unavailable, using in-memory storage', error);
    return new MemoryBackend();
  }
}

async function boot(): Promise<void> {
  const locale = usePreferences.getState().locale ?? detectLocale(navigator.languages ?? [navigator.language]);
  document.documentElement.lang = locale;
  const i18n = createI18n(locale);

  const handles = await createHandleStore().catch(() => ({ get: async () => undefined, put: async () => {} }));
  // The web app syncs only with the server it is served from (cookie auth, no CORS).
  const api = new HttpSyncApi(location.origin);
  const services: AppServices = {
    library: new Library(await openBackend()),
    platform: new WebPlatformAdapter(handles),
    i18n,
    renderMarkdown: createRenderer(),
    appVersion: __APP_VERSION__,
    server: { baseUrl: location.origin, api, health: () => api.health() },
  };

  if (navigator.storage?.persist) void navigator.storage.persist();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ServicesProvider services={services}>
          <AppShell />
        </ServicesProvider>
      </I18nextProvider>
    </StrictMode>,
  );
  await initWorkspace(services);
  await initSync(services);

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => console.warn('service worker registration failed', error));
  }
}

void boot();
