import { compareNames, type DocumentMeta, type Folder } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, ChevronRight, FolderOpen, FolderPlus, FolderInput, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useSync } from '../sync.ts';
import { useState } from 'react';
import { useWorkspace } from '../workspace.ts';
import type { LibraryAction } from './LibraryDialogs.tsx';

export function FolderTree({ folders, documents, onAction }: { folders: Folder[]; documents: DocumentMeta[]; onAction(action: LibraryAction): void }) {
  const { t, i18n } = useTranslation();
  const section = useWorkspace((s) => s.section);
  // Deleting the synced folder itself would delete the whole server library.
  const syncRoot = useSync((s) => s.connection?.folderId ?? null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const ids = new Set(folders.map((f) => f.id));
  const children = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const parentId = folder.parentId && ids.has(folder.parentId) ? folder.parentId : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(folder);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => compareNames(a.name, b.name, i18n.language));
  const toggle = (id: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const renderLevel = (parentId: string | null, ancestors: Set<string>) => (
    <ul className={parentId === null ? 'nav-list' : 'folder-children'}>
      {(children.get(parentId) ?? []).filter((folder) => !ancestors.has(folder.id)).map((folder) => {
        const expanded = !collapsed.has(folder.id);
        const hasChildren = (children.get(folder.id)?.length ?? 0) > 0;
        const active = section.kind === 'folder' && section.folderId === folder.id;
        return <li key={folder.id}>
          <div className="folder-row">
            {hasChildren ? <button type="button" className="icon-button small" aria-expanded={expanded} aria-label={t(expanded ? 'folders.collapse' : 'folders.expand', { name: folder.name })} onClick={() => toggle(folder.id)}>
              {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            </button> : <span className="folder-toggle-spacer" />}
            <button type="button" className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => useWorkspace.setState({ section: { kind: 'folder', folderId: folder.id } })}>
              <FolderOpen size={15} aria-hidden /><span className="truncate">{folder.name}</span>
              <span className="nav-count">{documents.filter((doc) => doc.folderId === folder.id).length}</span>
            </button>
            <Menu.Root>
              <Menu.Trigger className="icon-button small" aria-label={t('folders.actions', { name: folder.name })}><MoreHorizontal size={13} aria-hidden /></Menu.Trigger>
              <Menu.Portal><Menu.Content className="menu" align="end" sideOffset={4}>
                <Menu.Item className="menu-item" onSelect={() => { setCollapsed((previous) => new Set([...previous].filter((id) => id !== folder.id))); onAction({ kind: 'createFolder', parentId: folder.id }); }}><FolderPlus size={14} aria-hidden />{t('folders.newChild')}</Menu.Item>
                <Menu.Item className="menu-item" onSelect={() => onAction({ kind: 'renameFolder', folder })}><Pencil size={14} aria-hidden />{t('folders.rename')}</Menu.Item>
                <Menu.Item className="menu-item" onSelect={() => onAction({ kind: 'moveFolder', folder })}><FolderInput size={14} aria-hidden />{t('folders.move')}</Menu.Item>
                {folder.id !== syncRoot && <Menu.Item className="menu-item menu-item-danger" onSelect={() => onAction({ kind: 'deleteFolder', folder })}><Trash2 size={14} aria-hidden />{t('folders.delete')}</Menu.Item>}
              </Menu.Content></Menu.Portal>
            </Menu.Root>
          </div>
          {hasChildren && expanded && renderLevel(folder.id, new Set([...ancestors, folder.id]))}
        </li>;
      })}
    </ul>
  );
  return renderLevel(null, new Set());
}
