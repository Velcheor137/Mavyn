import { fileTypeByMime, type DocumentMeta, type SessionSaveState } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { AlertTriangle, Download, Eye, Trash2 } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { useServices } from '../services.tsx';
import { notifyError, setReadingPosition, trashDocument, useWorkspace } from '../workspace.ts';
import { DocumentMenu } from './DocumentMenu.tsx';
import { FileConflictBanner } from './SyncConflictBanner.tsx';
import { reconcileLinkedFile } from '../file-documents.ts';
import { SaveIndicator } from './SaveIndicator.tsx';

type ViewerProps = { bytes: Uint8Array; onError(error: unknown): void };
type EditorProps = { meta: DocumentMeta; bytes: Uint8Array; onError(error: unknown): void; onSaveState(state: SessionSaveState, version?: string): void };

// Editable formats; the viewer stays for the other version of a conflict.
const editors: Record<string, ComponentType<EditorProps>> = {
  xlsx: lazy(() => import('../sheets/SpreadsheetFile.tsx')),
  ods: lazy(() => import('../sheets/SpreadsheetFile.tsx')),
  docx: lazy(() => import('../docx/DocxFile.tsx')),
};

// Each viewer (and its library) loads only when a document of that type is opened.
const viewers: Record<string, ComponentType<ViewerProps>> = {
  docx: lazy(() => import('../viewers/DocxViewer.tsx')),
  xlsx: lazy(() => import('../viewers/SheetViewer.tsx')),
  ods: lazy(() => import('../viewers/SheetViewer.tsx')),
  pdf: lazy(() => import('../viewers/PdfViewer.tsx')),
};

/** View of a binary document (docx, xlsx, ods, pdf); editors for docx and spreadsheets hook in here. */
export function FileDocumentView({ meta }: { meta: DocumentMeta }) {
  const { t } = useTranslation();
  const { library, platform } = useServices();
  // Bytes and failure belong to one document: after switching tabs the previous document's state
  // must not reach the next editor for even one render (it would parse the wrong file).
  const [file, setFile] = useState<{ id: string; bytes: Uint8Array } | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const bytes = file?.id === meta.id ? file.bytes : null;
  const failed = failedId === meta.id;
  /** Server version of a conflicted file, shown read-only instead of the local bytes. */
  const [other, setOther] = useState<Uint8Array | null>(null);
  const [saveState, setSaveState] = useState<SessionSaveState>({ kind: 'saved', at: 0 });
  /** Hashes this view saved itself: the library change they cause must not reload the editor. */
  const ownVersions = useRef(new Set<string>());
  const scroller = useRef<HTMLDivElement>(null);
  const format = fileTypeByMime(meta.mime)?.format;
  const Viewer = format ? viewers[format] : undefined;
  const Editor = format ? editors[format] : undefined;

  useEffect(() => {
    ownVersions.current = new Set();
    setSaveState({ kind: 'saved', at: 0 });
  }, [meta.id]);

  const onSaveState = useCallback((state: SessionSaveState, version?: string) => {
    if (version) ownVersions.current.add(version);
    setSaveState(state);
  }, []);

  useEffect(() => {
    if (ownVersions.current.has(meta.contentHash)) return;
    let cancelled = false;
    const id = meta.id;
    setFile(null);
    setFailedId(null);
    // A linked file may have changed on disk while Mavyn was closed.
    (meta.source.kind === 'linked' ? reconcileLinkedFile(meta) : Promise.resolve())
      .then(() => library.readFile(id))
      .then((read) => !cancelled && setFile({ id, bytes: read.bytes }))
      .catch((error: unknown) => {
        if (cancelled) return;
        notifyError(error);
        setFailedId(id);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload for another document or new bytes only.
  }, [library, meta.id, meta.contentHash]);

  useEffect(() => {
    if (!meta.remote?.conflict) setOther(null);
  }, [meta.remote?.conflict]);

  const onError = useCallback((error: unknown) => {
    console.error(error);
    setFailedId(meta.id);
  }, [meta.id]);

  // Restore the scroll position once the viewer has content, then remember it.
  const restored = useRef(false);
  useEffect(() => {
    restored.current = false;
  }, [meta.id]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !bytes) return;
    if (typeof ResizeObserver === 'undefined') {
      restored.current = true;
      return;
    }
    const observer = new ResizeObserver(() => {
      if (restored.current || el.scrollHeight <= el.clientHeight) return;
      restored.current = true;
      const fraction = useWorkspace.getState().positions[meta.id] ?? 0;
      el.scrollTop = fraction * Math.max(0, el.scrollHeight - el.clientHeight);
    });
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [bytes, meta.id]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || !restored.current) return;
    const max = el.scrollHeight - el.clientHeight;
    const fraction = max > 0 ? el.scrollTop / max : 0;
    el.style.setProperty('--progress', String(fraction));
    setReadingPosition(meta.id, fraction);
  };

  const download = async () => {
    try {
      const file = await library.readFile(meta.id);
      await platform.saveAs(meta.fileName, file.bytes, meta.mime ?? 'application/octet-stream');
    } catch (error) {
      notifyError(error);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <div className="doc-toolbar" role="toolbar" aria-label={Editor ? t('files.toolbar') : t('viewer.viewOnly')}>
        <span className="file-badge" title={Editor ? undefined : t('viewer.viewOnly')}>
          {!Editor && <Eye size={14} aria-hidden />}
          <span>{format?.toUpperCase() ?? meta.mime}</span>
          {!Editor && <span className="hidden sm:inline muted">· {t('viewer.viewOnly')}</span>}
        </span>
        <div className="flex items-center gap-1 ml-auto">
          {Editor && !other && <SaveIndicator state={saveState} />}
          <button type="button" className="icon-button" onClick={() => void download()} aria-label={t('document.downloadOriginal')} title={t('document.downloadOriginal')}>
            <Download size={16} aria-hidden />
          </button>
          <button type="button" className="icon-button icon-button-danger" onClick={() => void trashDocument(meta.id).catch(notifyError)} aria-label={t('document.moveToTrash')} title={t('document.moveToTrash')}>
            <Trash2 size={16} aria-hidden />
          </button>
          <DocumentMenu meta={meta} />
        </div>
      </div>
      {meta.remote?.conflict && <FileConflictBanner id={meta.id} showingOther={other !== null} onShowOther={setOther} />}
      {other && <p className="banner banner-info small" role="status">{t('files.showingOther')}</p>}
      <section ref={scroller} className={`file-pane${Editor && !other && !failed ? ' file-pane-editor' : ''}`} onScroll={onScroll} tabIndex={-1} aria-label={meta.title}>
        <div className="reader-progress" aria-hidden />
        {failed || !Viewer ? (
          <div className="banner banner-warning file-error" role="alert">
            <AlertTriangle size={16} aria-hidden className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <strong>{t('viewer.failed')}</strong>
              <p>{t('viewer.failedHint')}</p>
            </div>
            <button type="button" className="button" onClick={() => void download()}>
              {t('document.downloadOriginal')}
            </button>
          </div>
        ) : Editor && bytes && !other ? (
          <Suspense fallback={<p className="muted file-loading">{t('app.loading')}</p>}>
            <Editor key={meta.id} meta={meta} bytes={bytes} onError={onError} onSaveState={onSaveState} />
          </Suspense>
        ) : other ?? bytes ? (
          <Suspense fallback={<p className="muted file-loading">{t('app.loading')}</p>}>
            <Viewer key={other ? `${meta.id}:server` : `${meta.id}:${meta.contentHash}`} bytes={(other ?? bytes)!} onError={onError} />
          </Suspense>
        ) : (
          <p className="muted file-loading">{t('app.loading')}</p>
        )}
      </section>
    </div>
  );
}
