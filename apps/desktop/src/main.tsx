import 'katex/dist/katex.min.css';
import '@mdr/ui/styles.css';
import { createI18n, detectLocale, I18nextProvider } from '@mdr/i18n';
import { render } from '@mdr/markdown-engine';
import { toAppError } from '@mdr/core';
import { addFiles, AppShell, initWorkspace, ServicesProvider, usePreferences, type AppServices } from '@mdr/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TauriPlatformAdapter } from './tauri-platform.ts';
import { openNativeLibrary } from './storage.ts';

declare const __APP_VERSION__: string;

const root = createRoot(document.getElementById('root')!);

/** Native SQLite, with an atomic one-time copy of the previous webview library. */
async function boot(): Promise<void> {
  const locale = usePreferences.getState().locale ?? detectLocale(navigator.languages ?? [navigator.language]);
  const i18n = createI18n(locale);
  root.render(<p role="status">{i18n.t('app.loading')}</p>);
  try {
    const platform = new TauriPlatformAdapter();
    const services: AppServices = {
      library: await openNativeLibrary(),
      platform,
      i18n,
      renderMarkdown: async (source, options) => render(source, options),
      appVersion: __APP_VERSION__,
    };
    root.render(
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
  } catch (cause) {
    const error = toAppError(cause);
    root.render(<main className="p-5 grid gap-3">
      <p role="alert">{i18n.t('app.startupFailed')}</p>
      <p>{i18n.t(`errors.${error.code}` as 'errors.unknown')}</p>
      <button type="button" className="button" onClick={() => window.location.reload()}>{i18n.t('app.retry')}</button>
    </main>);
  }
}

void boot();
