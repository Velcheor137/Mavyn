import { toAppError, type DocumentMeta, type ErrorCode, type Folder } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { useId, useState, type FormEvent } from 'react';
import { useServices } from '../services.tsx';
import { useSync } from '../sync.ts';
import { refreshLibrary, useWorkspace } from '../workspace.ts';
import { descendantIds, folderPaths } from './folders.ts';
import { Field, Modal } from './primitives.tsx';

export type LibraryAction =
  | { kind: 'createFolder'; parentId: string | null }
  | { kind: 'renameFolder' | 'moveFolder' | 'deleteFolder'; folder: Folder }
  | { kind: 'renameDocument' | 'moveDocument'; document: DocumentMeta };

/** Mounted per action so initial input never leaks from a previous document/folder. */
export function LibraryDialog({ action, onClose }: { action: LibraryAction; onClose(): void }) {
  const { t, i18n } = useTranslation();
  const { library } = useServices();
  const folders = useWorkspace((s) => s.folders);
  const documents = useWorkspace((s) => s.documents);
  const currentDocument = 'document' in action ? documents.find((doc) => doc.id === action.document.id) ?? action.document : null;
  const connection = useSync((s) => s.connection);
  const id = useId();
  const [name, setName] = useState('folder' in action ? action.folder.name : 'document' in action ? action.document.fileName : '');
  const [destination, setDestination] = useState(
    action.kind === 'createFolder' ? action.parentId ?? '' : 'folder' in action ? action.folder.parentId ?? '' : action.document.folderId ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const moving = action.kind === 'moveFolder' || action.kind === 'moveDocument';
  const deleting = action.kind === 'deleteFolder';
  const showDestination = moving || action.kind === 'createFolder';
  // Everything below the synced folder is mirrored on the server and on the other devices.
  const synced = connection ? descendantIds(folders, connection.folderId) : new Set<string>();
  const syncedTarget = synced.has(destination);
  const excluded = action.kind === 'moveFolder' ? descendantIds(folders, action.folder.id) : new Set<string>();
  const choices = folderPaths(folders, i18n.language).filter(({ folder }) => !excluded.has(folder.id));
  const titleKeys = { createFolder: 'sidebar.newFolder', renameFolder: 'folders.rename', moveFolder: 'folders.move', deleteFolder: 'folders.delete', renameDocument: 'document.rename', moveDocument: 'document.move' } as const;
  const deletedIds = deleting ? descendantIds(folders, action.folder.id) : new Set<string>();
  const deletedCount = documents.filter((doc) => doc.deletedAt === null && doc.folderId !== null && deletedIds.has(doc.folderId)).length;
  const headingTitle = currentDocument && currentDocument.title !== currentDocument.fileName.replace(/\.[^.]+$/, '') ? currentDocument.title : null;
  const title = t(titleKeys[action.kind]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || (!moving && !deleting && !name.trim())) return;
    setBusy(true);
    setError(null);
    try {
      const parentId = destination || null;
      switch (action.kind) {
        case 'createFolder': {
          const folder = await library.createFolder(name, parentId);
          useWorkspace.setState({ section: { kind: 'folder', folderId: folder.id } });
          break;
        }
        case 'renameFolder': await library.renameFolder(action.folder.id, name); break;
        case 'moveFolder': await library.moveFolder(action.folder.id, parentId); break;
        case 'deleteFolder': {
          await library.trashFolder(action.folder.id);
          const { section } = useWorkspace.getState();
          if (section.kind === 'folder' && deletedIds.has(section.folderId)) useWorkspace.setState({ section: { kind: 'all' } });
          break;
        }
        case 'renameDocument': await library.updateMeta(action.document.id, { fileName: name.trim() }); break;
        case 'moveDocument': await library.updateMeta(action.document.id, { folderId: parentId }); break;
      }
      await refreshLibrary();
      onClose();
    } catch (cause) {
      setError(toAppError(cause).code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={title} closeLabel={t('folders.cancel')}>
      <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
        {!moving && !deleting && <Field label={action.kind === 'renameDocument' ? t('document.fileName') : t('sidebar.folderName')} htmlFor={`${id}-name`}>
          <input id={`${id}-name`} className="input" value={name} onChange={(event) => setName(event.currentTarget.value)} disabled={busy} required autoFocus />
        </Field>}
        {showDestination && <Field label={t('folders.destination')} htmlFor={`${id}-destination`}>
          <select id={`${id}-destination`} className="input" value={destination} onChange={(event) => setDestination(event.currentTarget.value)} disabled={busy}>
            <option value="">{t('folders.root')}</option>
            {choices.map(({ folder, path }) => <option key={folder.id} value={folder.id}>{path}</option>)}
          </select>
        </Field>}
        {deleting && <p>{t('folders.deleteConfirm', { name: action.folder.name, count: deletedCount })}</p>}
        {deleting && synced.has(action.folder.id) && <p className="muted small">{t('folders.deleteSyncedHint')}</p>}
        {action.kind === 'renameDocument' && headingTitle && <p className="muted small">{t('folders.headingHint', { title: headingTitle })}</p>}
        {currentDocument?.source.kind === 'linked' && <p className="muted small">{t('folders.localOnlyHint')}</p>}
        {(action.kind === 'createFolder' || action.kind === 'moveFolder') && syncedTarget && <p className="muted small">{t('folders.syncedFolderHint')}</p>}
        {action.kind === 'moveDocument' && currentDocument?.remote && !syncedTarget && <p className="muted small">{t('folders.syncedHint')}</p>}
        {action.kind === 'moveDocument' && !currentDocument?.remote && syncedTarget && <p className="muted small" role="note">{t('folders.uploadHint')}</p>}
        {error && <p className="text-danger small" role="alert">{t(`errors.${error}` as 'errors.unknown')}</p>}
        <div className="flex gap-2 justify-end">
          <button type="button" className="button" disabled={busy} onClick={onClose}>{t('folders.cancel')}</button>
          <button type="submit" className={`button ${deleting ? 'button-danger' : 'button-primary'}`} disabled={busy || (!moving && !deleting && !name.trim())}>
            {busy ? t('folders.saving') : deleting ? t('folders.deleteAction') : moving ? t('folders.moveAction') : action.kind === 'createFolder' ? t('folders.create') : t('folders.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
