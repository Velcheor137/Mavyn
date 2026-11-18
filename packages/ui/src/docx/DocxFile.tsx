import type { DocumentMeta, SessionSaveState } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { Eye, Pencil } from 'lucide-react';
import type { Node as PMNode } from 'prosemirror-model';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { FileAutosaver, forkWithEdits } from '../file-documents.ts';
import { parseDocument, serializeDocument } from './convert.ts';
import { DocxEditor } from './DocxEditor.tsx';
import { disposePackage, readPackage, writePackage, type DocxPackage } from './package.ts';

const DocxViewer = lazy(() => import('../viewers/DocxViewer.tsx'));

/**
 * Word document: opens in the exact page view (docx-preview); "Edit" switches to the editor.
 * Edits autosave; a document with content Mavyn cannot save is edited as a copy.
 */
/** How many mounted views use a package; its image URLs are revoked when this drops to 0. */
const packageUsers = new WeakMap<DocxPackage, number>();

export default function DocxFile({ meta, bytes, onError, onSaveState }: {
  meta: DocumentMeta;
  bytes: Uint8Array;
  onError(error: unknown): void;
  onSaveState(state: SessionSaveState, version?: string): void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(bytes);
  const loaded = useMemo(() => {
    try {
      const pkg = readPackage(bytes);
      return { pkg, parsed: parseDocument(pkg) };
    } catch (error) {
      // Reported after rendering: the parent's state must not change during this render.
      queueMicrotask(() => onError(error));
      return null;
    }
  }, [bytes, onError]);
  const latest = useRef<PMNode | null>(null);
  // The document the editor starts from, fixed when editing begins: passing `latest` instead would
  // recreate the editor (losing focus and undo) on every re-render after an edit.
  const editStart = useRef<PMNode | null>(null);
  const saver = useRef<FileAutosaver | null>(null);
  const forked = useRef(false);

  useEffect(() => {
    if (!loaded) return;
    // Image URLs are released only once nothing shows this package any more: a remount of the
    // same package (React's StrictMode re-runs effects) must not revoke URLs still in use.
    const { pkg } = loaded;
    packageUsers.set(pkg, (packageUsers.get(pkg) ?? 0) + 1);
    return () => {
      packageUsers.set(pkg, packageUsers.get(pkg)! - 1);
      setTimeout(() => packageUsers.get(pkg) === 0 && disposePackage(pkg), 0);
    };
  }, [loaded]);
  useEffect(() => {
    // A new version (from another device or the disk) replaces whatever was being edited.
    latest.current = null;
    editStart.current = null;
  }, [loaded]);
  useEffect(() => setCurrent(bytes), [bytes]);
  useEffect(() => {
    saver.current = new FileAutosaver(meta.id, meta.contentHash, onSaveState);
    return () => {
      void saver.current?.dispose();
      saver.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id]);

  if (!loaded) return null;
  const serialize = async () => writePackage(loaded.pkg, serializeDocument(loaded.parsed, latest.current ?? loaded.parsed.doc));

  const switchTo = async (edit: boolean) => {
    if (!edit && latest.current) {
      await saver.current?.flush();
      setCurrent(await serialize());
    }
    if (edit) editStart.current = latest.current ?? loaded.parsed.doc;
    setEditing(edit);
  };

  return (
    <div className="docx-file">
      <div className="docx-mode" role="radiogroup" aria-label={t('docx.mode')}>
        <div className="segmented">
          <button type="button" role="radio" aria-checked={!editing} className="segmented-item" onClick={() => void switchTo(false)}>
            <Eye size={15} aria-hidden />
            <span>{t('docx.view')}</span>
          </button>
          <button type="button" role="radio" aria-checked={editing} className="segmented-item" onClick={() => void switchTo(true)}>
            <Pencil size={15} aria-hidden />
            <span>{t('docx.edit')}</span>
          </button>
        </div>
        {editing && loaded.pkg.unsupported.length > 0 && <span className="muted small">{t('docx.copyHint')}</span>}
      </div>
      {editing ? (
        <DocxEditor
          pkg={loaded.pkg}
          doc={editStart.current ?? loaded.parsed.doc}
          onChange={(doc) => {
            latest.current = doc;
            if (loaded.pkg.unsupported.length) {
              if (forked.current) return;
              forked.current = true;
              void serialize().then((edited) => forkWithEdits(meta.id, edited, loaded.pkg.unsupported), onError);
              return;
            }
            saver.current?.schedule(serialize);
          }}
        />
      ) : (
        <div className="docx-view-scroll">
          <Suspense fallback={<p className="muted file-loading">{t('app.loading')}</p>}>
            <DocxViewer key={current.length} bytes={current} onError={onError} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
