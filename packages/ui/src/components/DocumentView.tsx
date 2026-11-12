import { AppError, encodeUtf8, toAppError, type DocumentSession } from '@mdr/core';
import { createMarkdownEditor, type FormatCommand, type MarkdownEditor } from '@mdr/editor';
import { useTranslation } from '@mdr/i18n';
import { toggleTask } from '@mdr/markdown-engine';
import { AlertTriangle, BookOpen, Code2, Columns2, Download, History, Redo2, Trash2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useRendered, useSession } from '../hooks.ts';
import { usePreferences, type ViewMode } from '../preferences.ts';
import { useServices } from '../services.tsx';
import { notify, notifyError, reloadDocument, saveAsCopy, setReadingPosition, setViewMode, trashDocument, useWorkspace } from '../workspace.ts';
import { DocumentMenu } from './DocumentMenu.tsx';
import { EditorToolbar } from './EditorToolbar.tsx';
import { ImageLightbox } from './ImageLightbox.tsx';
import { MarkdownView } from './MarkdownView.tsx';
import { SaveIndicator } from './SaveIndicator.tsx';
import { SyncConflictBanner } from './SyncConflictBanner.tsx';

export function DocumentView({ id, onShowHistory, outlineToggle }: { id: string; onShowHistory(): void; outlineToggle: ReactNode }) {
  const { t } = useTranslation();
  const session = useSession(id);
  const defaultMode = usePreferences((p) => p.defaultViewMode);
  const mode = useWorkspace((s) => s.viewModes[id]) ?? defaultMode;
  const meta = useWorkspace((s) => s.documents.find((d) => d.id === id));
  const { platform } = useServices();

  if (!session || !meta) {
    return <div className="flex-1 grid place-items-center muted">{t('app.loading')}</div>;
  }

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <div className="doc-toolbar" role="toolbar" aria-label={t('document.viewMode')}>
        <ViewModeSwitch value={mode} onChange={(m) => setViewMode(id, m)} />
        <div className="flex items-center gap-1 ml-auto">
          <SaveIndicator state={session.saveState} />
          <button type="button" className="icon-button" onClick={() => session.undo()} disabled={!session.canUndo} aria-label={t('editor.undo')} title={`${t('editor.undo')} (Ctrl+Z)`}>
            <Undo2 size={16} aria-hidden />
          </button>
          <button type="button" className="icon-button" onClick={() => session.redo()} disabled={!session.canRedo} aria-label={t('editor.redo')} title={`${t('editor.redo')} (Ctrl+Shift+Z)`}>
            <Redo2 size={16} aria-hidden />
          </button>
          <button type="button" className="icon-button" onClick={onShowHistory} aria-label={t('document.history')} title={t('document.history')}>
            <History size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void platform.saveAs(meta.fileName || 'document.md', encodeUtf8({ text: session.text, bom: meta.bom }), 'text/markdown;charset=utf-8').catch(notifyError)}
            aria-label={t('document.download')}
            title={t('document.download')}
          >
            <Download size={16} aria-hidden />
          </button>
          <button type="button" className="icon-button icon-button-danger" onClick={() => void trashDocument(id).catch(notifyError)} aria-label={t('document.moveToTrash')} title={t('document.moveToTrash')}>
            <Trash2 size={16} aria-hidden />
          </button>
          <DocumentMenu meta={meta} session={session} />
          {outlineToggle}
        </div>
      </div>
      {session.saveState.kind === 'conflict' && <ConflictBanner id={id} />}
      {meta.remote?.conflict && <SyncConflictBanner id={id} />}
      <DocumentPanes key={id} id={id} session={session} mode={mode} />
    </div>
  );
}

function ViewModeSwitch({ value, onChange }: { value: ViewMode; onChange(mode: ViewMode): void }) {
  const { t } = useTranslation();
  const options: Array<[ViewMode, string, ReactNode]> = [
    ['reader', t('document.reader'), <BookOpen key="r" size={15} aria-hidden />],
    ['source', t('document.source'), <Code2 key="s" size={15} aria-hidden />],
    ['split', t('document.split'), <Columns2 key="p" size={15} aria-hidden />],
  ];
  return (
    <div className="segmented" role="radiogroup" aria-label={t('document.viewMode')}>
      {options.map(([mode, label, icon]) => (
        <button key={mode} type="button" role="radio" aria-checked={value === mode} className="segmented-item" onClick={() => onChange(mode)} title={label}>
          {icon}
          <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}

function ConflictBanner({ id }: { id: string }) {
  const { t } = useTranslation();
  return (
    <div className="banner banner-warning" role="alert">
      <AlertTriangle size={16} aria-hidden className="shrink-0 mt-0.5" />
      <div className="flex-1">
        <strong>{t('conflict.title')}</strong>
        <p>{t('conflict.description')}</p>
        <p className="muted">{t('conflict.undoHint')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="button" onClick={() => void reloadDocument(id)}>
          {t('conflict.reload')}
        </button>
        <button type="button" className="button button-primary" onClick={() => void saveAsCopy(id, t('conflict.keepMine'))}>
          {t('conflict.keepMine')}
        </button>
      </div>
    </div>
  );
}

function DocumentPanes({ id, session, mode }: { id: string; session: DocumentSession; mode: ViewMode }) {
  const { t } = useTranslation();
  const showReader = mode !== 'source';
  const showEditor = mode !== 'reader';
  const { result, error } = useRendered(showReader ? session.text : undefined, mode === 'split' ? 150 : 0);
  const readerRef = useRef<HTMLDivElement>(null);
  const editorHost = useRef<HTMLDivElement>(null);
  const editor = useRef<MarkdownEditor | null>(null);
  const editorLineNumbers = usePreferences((p) => p.editorLineNumbers);
  const editorWrap = usePreferences((p) => p.editorWrap);
  const [overrides, setOverrides] = useState<ReadonlyMap<number, boolean>>(new Map());
  const [lightbox, setLightbox] = useState<string | null>(null);
  /**
   * Fingerprint of the text for which the rendered task offsets are valid. A task toggle replaces
   * one character, so offsets stay valid across consecutive toggles; any other edit invalidates
   * them until the next render.
   */
  const offsetsValidFor = useRef<string | null>(null);

  useEffect(() => {
    if (!result) return;
    offsetsValidFor.current = result.sourceFingerprint;
    setOverrides(new Map());
  }, [result]);

  useEffect(
    () =>
      session.subscribe((event) => {
        if (event && event.origin !== 'task') offsetsValidFor.current = null;
      }),
    [session],
  );

  const onToggleTask = useCallback(
    (offset: number, checked: boolean) => {
      try {
        if (offsetsValidFor.current === null) throw new AppError('edit.stale_revision');
        const edit = toggleTask(session.text, offset, offsetsValidFor.current, checked);
        setOverrides((prev) => new Map(prev).set(offset, checked));
        session.apply([edit], 'task');
        offsetsValidFor.current = session.fingerprint;
      } catch (error) {
        const code = toAppError(error).code;
        if (code === 'edit.stale_revision' || code === 'edit.marker_mismatch') notify(`errors.${code}`, 'error');
        else notifyError(error);
      }
    },
    [session],
  );

  // Editor lifecycle: created when the source pane is visible.
  useLayoutEffect(() => {
    if (!showEditor || !editorHost.current) return;
    const prefs = usePreferences.getState();
    editor.current = createMarkdownEditor({
      parent: editorHost.current,
      session,
      options: { lineNumbers: prefs.editorLineNumbers, wrap: prefs.editorWrap },
      ariaLabel: t('editor.label'),
      onTopLineChange: (line) => {
        if (mode === 'split') syncReaderToLine(readerRef.current, line);
      },
    });
    return () => {
      editor.current?.destroy();
      editor.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recreate only when visibility/session/mode changes.
  }, [showEditor, session, mode]);

  useEffect(() => {
    editor.current?.setOptions({ lineNumbers: editorLineNumbers, wrap: editorWrap });
  }, [editorLineNumbers, editorWrap]);

  // Restore and remember the reading position.
  const restored = useRef(false);
  useEffect(() => {
    const el = readerRef.current;
    if (!el || !result || restored.current) return;
    restored.current = true;
    const fraction = useWorkspace.getState().positions[id] ?? 0;
    el.scrollTop = fraction * Math.max(0, el.scrollHeight - el.clientHeight);
  }, [id, result]);

  const onReaderScroll = () => {
    const el = readerRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const fraction = max > 0 ? el.scrollTop / max : 0;
    el.style.setProperty('--progress', String(fraction));
    setReadingPosition(id, fraction);
  };

  const onInternalLink = (href: string) => {
    if (href.startsWith('#')) {
      const target = decodeURIComponent(href.slice(1));
      const el = readerRef.current?.querySelector(`[id="${CSS.escape(target)}"], [id="${CSS.escape(`user-content-${target}`)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const onReaderDoubleClick = (event: MouseEvent) => {
    if (!showEditor) return;
    const block = (event.target as HTMLElement).closest('[data-line]');
    const line = Number(block?.getAttribute('data-line'));
    if (line > 0) editor.current?.scrollToLine(line);
  };

  const format = (command: FormatCommand) => editor.current?.format(command);

  return (
    <div className={`doc-panes mode-${mode}`}>
      {showEditor && (
        <section className="editor-pane" aria-label={t('editor.label')}>
          <EditorToolbar onFormat={format} />
          <div ref={editorHost} className="editor-host" />
        </section>
      )}
      {showReader && (
        <section ref={readerRef} className="reader-pane" onScroll={onReaderScroll} onDoubleClick={onReaderDoubleClick} tabIndex={-1} data-reader-scroll="">
          <div className="reader-progress" aria-hidden />
          <article className="reader-content">
            {error !== null && (
              <div className="banner banner-warning render-error" role="alert">
                <AlertTriangle size={16} aria-hidden className="shrink-0 mt-0.5" />
                <div className="flex-1">
                  <strong>{t('document.renderFailed')}</strong>
                  <p>{t(result ? 'document.renderStale' : 'document.renderFailedHint')}</p>
                </div>
                {mode === 'reader' && (
                  <button type="button" className="button" onClick={() => setViewMode(id, 'source')}>
                    {t('document.source')}
                  </button>
                )}
              </div>
            )}
            {result ? (
              <MarkdownView result={result} overrides={overrides} onToggleTask={onToggleTask} onOpenImage={setLightbox} onInternalLink={onInternalLink} />
            ) : (
              error === null && <p className="muted">{t('app.loading')}</p>
            )}
          </article>
        </section>
      )}
      <ImageLightbox src={lightbox} container={readerRef} onClose={() => setLightbox(null)} onNavigate={setLightbox} />
    </div>
  );
}

function syncReaderToLine(reader: HTMLElement | null, line: number): void {
  if (!reader) return;
  let best: HTMLElement | null = null;
  for (const el of reader.querySelectorAll<HTMLElement>('[data-line]')) {
    if (Number(el.dataset.line) <= line) best = el;
    else break;
  }
  if (best) reader.scrollTop = best.offsetTop - reader.offsetTop - 8;
  else reader.scrollTop = 0;
}
