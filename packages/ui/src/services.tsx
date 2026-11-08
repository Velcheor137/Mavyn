import type { I18n } from '@mdr/i18n';
import type { RenderOptions, RenderResult } from '@mdr/markdown-engine';
import type { PlatformAdapter } from '@mdr/platform';
import type { Library } from '@mdr/storage';
import type { SyncApi } from '@mdr/sync-client';
import { createContext, useContext, type ReactNode } from 'react';

/**
 * Everything platform- or storage-specific the UI needs, injected by each app entry point
 * (web, desktop). UI components never construct these themselves.
 */
export interface AppServices {
  library: Library;
  platform: PlatformAdapter;
  i18n: I18n;
  /** Renders Markdown, possibly off the main thread. */
  renderMarkdown(source: string, options: RenderOptions): Promise<RenderResult>;
  appVersion: string;
  /** Sync server serving this app (web: same origin). Absent when sync is unavailable. */
  server?: { baseUrl: string; api: SyncApi; health(): Promise<boolean> };
  /** Native apps can configure an HTTPS origin; credentials are held by the OS vault. */
  configureServer?(url: string): Promise<AppServices['server']>;
  /**
   * Set by builds that require an account (the web app served by a Mavyn server): called after
   * sign-out and when the server reports the session as gone, to return to the sign-in page.
   */
  onSignedOut?(): void;
}

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesProvider>');
  return services;
}
