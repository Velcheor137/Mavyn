export { AppShell } from './components/AppShell.tsx';
export { MarkdownView } from './components/MarkdownView.tsx';
export { ServicesProvider, useServices, type AppServices } from './services.tsx';
export {
  applyPreferences,
  DEFAULT_PREFERENCES,
  sanitizePreferences,
  usePreferences,
  type Preferences,
} from './preferences.ts';
export { initWorkspace, useWorkspace, getSession, resetWorkspaceForTests, openDocument, addFiles, notifyError } from './workspace.ts';
export { buildStandaloneHtml } from './export.ts';
export { THEME_BOOTSTRAP_SCRIPT, PREFS_KEY } from './theme-bootstrap.ts';
export { initSync, resetSyncForTests, useSync } from './sync.ts';
export { AuthGate, type AuthenticatedUser } from './components/AuthGate.tsx';
