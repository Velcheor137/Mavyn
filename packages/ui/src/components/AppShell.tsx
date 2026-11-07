import { detectLocale, useTranslation } from '@mdr/i18n';
import { isMarkdownName, fileToPicked } from '@mdr/platform';
import { FilePlus2, FolderOpen, Maximize2, Minimize2, PanelLeft, PanelRight, X } from 'lucide-react';
import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { useMediaQuery } from '../hooks.ts';
import { applyPreferences, usePreferences } from '../preferences.ts';
import { addFiles, applyAutosaveDelay, closeTab, createDocument, cycleTab, dismissToast, flushAll, getSession, setViewMode, useWorkspace } from '../workspace.ts';
import { DocumentView } from './DocumentView.tsx';
import { HistoryDialog } from './HistoryDialog.tsx';
import { OpenFilesDialog } from './OpenFilesDialog.tsx';
import { Outline } from './Outline.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { SetupDialog } from './SetupDialog.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TabBar } from './TabBar.tsx';

export function AppShell() {
  const { t, i18n } = useTranslation();
  const prefs = usePreferences();
  const ready = useWorkspace((s) => s.ready);
  const active = useWorkspace((s) => s.active);
  const toasts = useWorkspace((s) => s.toasts);
  const mobile = useMediaQuery('(max-width: 767px)');
  // The outline needs room next to the document; below this width it is hidden.
  const roomForOutline = useMediaQuery('(min-width: 1100px)');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openFilesOpen, setOpenFilesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Theme and reading preferences; follow OS theme changes in "system" mode.
  useEffect(() => {
    applyPreferences(prefs);
    const mql = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => applyPreferences(usePreferences.getState());
    mql?.addEventListener('change', onChange);
    return () => mql?.removeEventListener('change', onChange);
  }, [prefs]);

  // Language: explicit choice or browser/OS preference, applied without reload.
  useEffect(() => {
    const locale = prefs.locale ?? detectLocale(navigator.languages ?? [navigator.language]);
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
    document.documentElement.lang = locale;
  }, [prefs.locale, i18n]);

  useEffect(() => applyAutosaveDelay(prefs.autosaveDelayMs), [prefs.autosaveDelayMs]);

  // Save pending edits when the page is hidden or closed.
  useEffect(() => {
    const onHide = () => void flushAll();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const { tabs } = useWorkspace.getState();
      if (tabs.some((id) => ['dirty', 'saving'].includes(getSession(id)?.saveState.kind ?? ''))) {
        void flushAll();
        e.preventDefault();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  const newDocument = useCallback(() => void createDocument(t('document.untitled')), [t]);

  // Keyboard shortcuts. Browser-reserved combos (Ctrl+W, Ctrl+Tab) have web alternatives.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const { active: current } = useWorkspace.getState();
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setOpenFilesOpen(true);
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void flushAll();
      } else if (mod && e.key.toLowerCase() === 'k') {
        if ((e.target as HTMLElement).closest?.('.cm-editor')) return;
        e.preventDefault();
        document.getElementById('library-search')?.focus();
      } else if (mod && e.key === '\\') {
        e.preventDefault();
        usePreferences.getState().set({ sidebarOpen: !usePreferences.getState().sidebarOpen });
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'e' && current) {
        e.preventDefault();
        const mode = useWorkspace.getState().viewModes[current] ?? usePreferences.getState().defaultViewMode;
        setViewMode(current, mode === 'reader' ? 'source' : 'reader');
      } else if ((mod && e.key === 'Tab') || (mod && (e.key === 'PageDown' || e.key === 'PageUp'))) {
        e.preventDefault();
        cycleTab(e.shiftKey || e.key === 'PageUp' ? -1 : 1);
      } else if (((mod && e.key.toLowerCase() === 'w') || (e.altKey && e.key.toLowerCase() === 'w')) && current) {
        e.preventDefault();
        void closeTab(current);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFocusMode((f) => !f);
      } else if (e.key === 'Escape') {
        setFocusMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files].filter((f) => isMarkdownName(f.name));
    if (files.length) await addFiles(await Promise.all(files.map(fileToPicked)));
  };

  if (!ready) return <div className="h-full grid place-items-center muted">{t('app.loading')}</div>;

  const sidebar = (
    <Sidebar
      onNewDocument={() => {
        setMobileNav(false);
        newDocument();
      }}
      onOpenFile={() => setOpenFilesOpen(true)}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
  const showSidebar = !focusMode && (mobile ? mobileNav : prefs.sidebarOpen);
  const showOutline = !focusMode && roomForOutline && prefs.outlineOpen && active !== null;

  return (
    <div
      className={`app ${focusMode ? 'focus-mode' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <a href="#main" className="skip-link">
        {t('app.skipToContent')}
      </a>
      {showSidebar && (mobile ? <div className="mobile-drawer" onClick={(e) => e.target === e.currentTarget && setMobileNav(false)}>{sidebar}</div> : <div className="sidebar-wrap" style={{ width: prefs.sidebarWidth }}>{sidebar}<SidebarResizer /></div>)}

      <main id="main" className="main" onClick={() => mobile && mobileNav && setMobileNav(false)}>
        <header className="topbar">
          {!focusMode && (
            <button
              type="button"
              className="icon-button"
              onClick={() => (mobile ? setMobileNav((v) => !v) : prefs.set({ sidebarOpen: !prefs.sidebarOpen }))}
              aria-label={t('a11y.toggleSidebar')}
              aria-expanded={showSidebar}
              title={`${t('a11y.toggleSidebar')} (Ctrl+\\)`}
            >
              <PanelLeft size={16} aria-hidden />
            </button>
          )}
          <TabBar />
          <button type="button" className="icon-button ml-auto" onClick={() => setFocusMode((f) => !f)} aria-label={focusMode ? t('document.exitFullscreen') : t('document.fullscreen')} title={`${focusMode ? t('document.exitFullscreen') : t('document.fullscreen')} (Ctrl+Shift+F)`}>
            {focusMode ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
          </button>
        </header>

        <div className="workspace">
          {active ? (
            <DocumentView
              id={active}
              onShowHistory={() => setHistoryOpen(true)}
              outlineToggle={
                roomForOutline && (
                  <button type="button" className="icon-button" onClick={() => prefs.set({ outlineOpen: !prefs.outlineOpen })} aria-label={t('a11y.toggleOutline')} aria-expanded={prefs.outlineOpen}>
                    <PanelRight size={16} aria-hidden />
                  </button>
                )
              }
            />
          ) : (
            <EmptyState onNew={newDocument} onOpen={() => setOpenFilesOpen(true)} />
          )}
          {showOutline && active && <Outline id={active} />}
        </div>
      </main>

      {dragging && (
        <div className="drop-overlay" aria-hidden>
          {t('document.dropHint')}
        </div>
      )}

      <div className="toasts" role="region" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
            <span>{t(toast.message as 'errors.unknown', toast.values ?? {})}</span>
            <button type="button" className="icon-button small" onClick={() => dismissToast(toast.id)} aria-label={t('settings.dismiss')}>
              <X size={12} aria-hidden />
            </button>
          </div>
        ))}
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <SetupDialog />
      <OpenFilesDialog open={openFilesOpen} onOpenChange={setOpenFilesOpen} />
      {active && <HistoryDialog id={active} open={historyOpen} onOpenChange={setHistoryOpen} />}
    </div>
  );
}

function EmptyState({ onNew, onOpen }: { onNew(): void; onOpen(): void }) {
  const { t } = useTranslation();
  return (
    <div className="empty-state">
      <h1>{t('document.emptyTitle')}</h1>
      <p className="muted">{t('document.emptyHint')}</p>
      <div className="flex gap-2 justify-center flex-wrap">
        <button type="button" className="button button-primary" onClick={onNew}>
          <FilePlus2 size={15} aria-hidden />
          {t('sidebar.newDocument')}
        </button>
        <button type="button" className="button" onClick={onOpen}>
          <FolderOpen size={15} aria-hidden />
          {t('sidebar.openFile')}
        </button>
      </div>
    </div>
  );
}

function SidebarResizer() {
  const { t } = useTranslation();
  const width = usePreferences((p) => p.sidebarWidth);
  const set = usePreferences((p) => p.set);
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('a11y.resizeSidebar')}
      aria-valuenow={width}
      aria-valuemin={200}
      aria-valuemax={520}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') set({ sidebarWidth: Math.max(200, width - 16) });
        if (e.key === 'ArrowRight') set({ sidebarWidth: Math.min(520, width + 16) });
      }}
      onPointerDown={(e) => {
        const startX = e.clientX;
        const start = width;
        const move = (ev: PointerEvent) => set({ sidebarWidth: Math.min(520, Math.max(200, start + ev.clientX - startX)) });
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}
