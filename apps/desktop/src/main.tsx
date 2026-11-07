import 'katex/dist/katex.min.css';
import '@mdr/ui/styles.css';
import { createI18n, detectLocale, I18nextProvider } from '@mdr/i18n';
import { render } from '@mdr/markdown-engine';
import { IndexedDbBackend, Library } from '@mdr/storage';
import { addFiles, AppShell, initWorkspace, ServicesProvider, usePreferences, type AppServices } from '@mdr/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TauriPlatformAdapter } from './tauri-platform.ts';

declare const __APP_VERSION__: string;

/**
 * Desktop entry. The library currently uses the webview's IndexedDB, like the web build; the
 * SQLite/FTS5 store described in docs/architecture.md is not implemented yet (docs/status.md).
 */
async function boot(): Promise<void> {
  const locale = usePreferences.getState().locale ?? detectLocale(navigator.languages ?? [navigator.language]);
  const i18n = createI18n(locale);
  const platform = new TauriPlatformAdapter();
  const services: AppServices = {
    library: new Library(await IndexedDbBackend.open('mdreader:local')),
    platform,
    i18n,
    renderMarkdown: async (source, options) => render(source, options),
    appVersion: __APP_VERSION__,
  };
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
  const launched = await platform.takeLaunchFiles().catch(() => []);
  if (launched.length) await addFiles(launched);
}

void boot();
