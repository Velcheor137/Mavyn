import { compareNames, type DocumentMeta } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { Clock, FileText, Files, FolderOpen, FolderPlus, Hash, Plus, RotateCcw, Search, Settings, Star, Trash2, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useRelativeTime } from '../hooks.ts';
import { SyncStatus } from './SyncStatus.tsx';
import { FolderTree } from './FolderTree.tsx';
import { LibraryDialog, type LibraryAction } from './LibraryDialogs.tsx';
import { openDocument, purgeDocument, restoreDocument, search, useWorkspace, notifyError, type Section } from '../workspace.ts';

export function Sidebar({ onNewDocument, onOpenFile, onOpenSettings }: { onNewDocument(): void; onOpenFile(): void; onOpenSettings(): void }) {
  const { t, i18n } = useTranslation();
  const [action, setAction] = useState<LibraryAction | null>(null);
  const documents = useWorkspace((s) => s.documents);
  const folders = useWorkspace((s) => s.folders);
  const section = useWorkspace((s) => s.section);
  const query = useWorkspace((s) => s.query);
  const hits = useWorkspace((s) => s.hits);
  const active = useWorkspace((s) => s.active);
  const locale = i18n.language;

  const live = documents.filter((d) => d.deletedAt === null);
  const tags = useMemo(() => {
    const map = new Map<string, number>();
    for (const doc of live) for (const tag of doc.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
    return [...map].sort((a, b) => compareNames(a[0], b[0], locale));
  }, [live, locale]);

  const visible = useMemo(() => {
    const byUpdated = (a: DocumentMeta, b: DocumentMeta) => b.updatedAt.localeCompare(a.updatedAt);
    switch (section.kind) {
      case 'favorites':
        return live.filter((d) => d.favorite).sort((a, b) => compareNames(a.title, b.title, locale));
      case 'recent':
        return live.filter((d) => d.openedAt).sort((a, b) => b.openedAt!.localeCompare(a.openedAt!)).slice(0, 30);
      case 'trash':
        return documents.filter((d) => d.deletedAt !== null).sort(byUpdated);
      case 'tag':
        return live.filter((d) => d.tags.includes(section.tag)).sort((a, b) => compareNames(a.title, b.title, locale));
      case 'folder':
        return live.filter((d) => d.folderId === section.folderId).sort((a, b) => compareNames(a.title, b.title, locale));
      default:
        return [...live].sort(byUpdated);
    }
  }, [section, live, documents, locale]);

  // Documents sharing a title (e.g. conflict copies) are told apart by file name.
  const duplicateTitles = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const doc of visible) (seen.has(doc.title) ? dupes : seen).add(doc.title);
    return dupes;
  }, [visible]);

  const setSection = (next: Section) => useWorkspace.setState({ section: next });
  const isSection = (kind: Section['kind'], key?: string) =>
    section.kind === kind && (key === undefined || (section.kind === 'tag' && section.tag === key) || (section.kind === 'folder' && section.folderId === key));

  const byId = new Map(documents.map((d) => [d.id, d]));

  return (
    <nav className="sidebar" aria-label={t('a11y.mainNavigation')}>
      <div className="sidebar-actions">
        <button type="button" className="button button-primary flex-1" onClick={onNewDocument}>
          <Plus size={15} aria-hidden />
          {t('sidebar.newDocument')}
        </button>
        <button type="button" className="icon-button" onClick={onOpenFile} aria-label={t('sidebar.openFile')} title={`${t('sidebar.openFile')} (Ctrl+O)`}>
          <FolderOpen size={16} aria-hidden />
        </button>
      </div>

      <div className="search-box">
        <Search size={14} aria-hidden className="muted" />
        <input
          id="library-search"
          type="search"
          value={query}
          placeholder={t('sidebar.searchPlaceholder')}
          aria-label={t('sidebar.search')}
          onChange={(e) => void search(e.currentTarget.value)}
        />
        {query && (
          <button type="button" className="icon-button small" onClick={() => void search('')} aria-label={t('sidebar.clearSearch')}>
            <X size={12} aria-hidden />
          </button>
        )}
      </div>

      {hits ? (
        <div className="sidebar-scroll">
          <p className="sidebar-heading">{t('sidebar.searchResults', { count: hits.length })}</p>
          {hits.length === 0 && <p className="sidebar-empty">{t('sidebar.noResults')}</p>}
          <ul className="doc-list">
            {hits.map((hit) => {
              const doc = byId.get(hit.documentId);
              if (!doc) return null;
              return (
                <li key={hit.documentId}>
                  <button type="button" className={`doc-item ${active === doc.id ? 'active' : ''}`} onClick={() => void openDocument(doc.id)}>
                    <span className="doc-title">{doc.title}</span>
                    <Highlighted text={hit.snippet} ranges={hit.ranges} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="sidebar-scroll">
          <ul className="nav-list">
            <NavItem icon={<Files size={15} aria-hidden />} label={t('sidebar.allDocuments')} count={live.length} active={isSection('all')} onClick={() => setSection({ kind: 'all' })} />
            <NavItem icon={<Star size={15} aria-hidden />} label={t('sidebar.favorites')} active={isSection('favorites')} onClick={() => setSection({ kind: 'favorites' })} />
            <NavItem icon={<Clock size={15} aria-hidden />} label={t('sidebar.recent')} active={isSection('recent')} onClick={() => setSection({ kind: 'recent' })} />
            <NavItem icon={<Trash2 size={15} aria-hidden />} label={t('sidebar.trash')} active={isSection('trash')} onClick={() => setSection({ kind: 'trash' })} />
          </ul>

          <div className="sidebar-heading-row">
            <p className="sidebar-heading">{t('sidebar.folders')}</p>
            <button type="button" className="icon-button small" onClick={() => setAction({ kind: 'createFolder', parentId: null })} aria-label={t('sidebar.newFolder')} title={t('sidebar.newFolder')}>
              <FolderPlus size={13} aria-hidden />
            </button>
          </div>
          <FolderTree folders={folders} documents={live} onAction={setAction} />

          {tags.length > 0 && (
            <>
              <p className="sidebar-heading">{t('sidebar.tags')}</p>
              <ul className="nav-list">
                {tags.map(([tag, count]) => (
                  <NavItem key={tag} icon={<Hash size={15} aria-hidden />} label={tag} count={count} active={isSection('tag', tag)} onClick={() => setSection({ kind: 'tag', tag })} />
                ))}
              </ul>
            </>
          )}

          <p className="sidebar-heading">{t('sidebar.documentsCount', { count: visible.length })}</p>
          {visible.length === 0 && <p className="sidebar-empty">{t('sidebar.noDocuments')}</p>}
          <ul className="doc-list">
            {visible.map((doc) => (
              <DocItem key={doc.id} doc={doc} active={active === doc.id} trash={section.kind === 'trash'} showFileName={duplicateTitles.has(doc.title)} />
            ))}
          </ul>
        </div>
      )}

      <div className="sidebar-footer">
        <button type="button" className="nav-item" onClick={onOpenSettings}>
          <Settings size={15} aria-hidden />
          <span>{t('sidebar.settings')}</span>
        </button>
        <SyncStatus />
      </div>
      {action && <LibraryDialog action={action} onClose={() => setAction(null)} />}
    </nav>
  );
}

function NavItem({ icon, label, count, active, onClick }: { icon: ReactNode; label: string; count?: number; active: boolean; onClick(): void }) {
  return (
    <li>
      <button type="button" className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
        {icon}
        <span className="truncate">{label}</span>
        {count !== undefined && <span className="nav-count">{count}</span>}
      </button>
    </li>
  );
}

function DocItem({ doc, active, trash, showFileName }: { doc: DocumentMeta; active: boolean; trash: boolean; showFileName: boolean }) {
  const { t, i18n } = useTranslation();
  const relative = useRelativeTime(i18n.language);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="doc-row">
      <button type="button" className={`doc-item ${active ? 'active' : ''}`} onClick={() => !trash && void openDocument(doc.id)} aria-current={active ? 'true' : undefined} disabled={trash}>
        <span className="doc-title">
          <FileText size={14} aria-hidden className="muted shrink-0" />
          <span className="truncate">{doc.title || t('document.untitled')}</span>
          {doc.favorite && <Star size={12} aria-hidden className="text-accent shrink-0" fill="currentColor" />}
        </span>
        <span className="doc-meta">
          {showFileName && <span className="truncate">{doc.fileName} · </span>}
          <time dateTime={doc.updatedAt}>{relative(doc.updatedAt)}</time>
        </span>
      </button>
      {trash && (
        <div className="doc-row-actions">
          <button type="button" className="icon-button small" disabled={busy} onClick={() => void run(() => restoreDocument(doc.id))} aria-label={t('document.restore')} title={t('document.restore')}>
            <RotateCcw size={13} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-button small text-danger"
            disabled={busy}
            onClick={() => window.confirm(t('document.deleteForeverConfirm', { title: doc.title })) && void run(() => purgeDocument(doc.id))}
            aria-label={t('document.deleteForever')}
            title={t('document.deleteForever')}
          >
            <Trash2 size={13} aria-hidden />
          </button>
        </div>
      )}
    </li>
  );
}

function Highlighted({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([from, to], i) => {
    if (from < pos) return;
    parts.push(text.slice(pos, from), <mark key={i}>{text.slice(from, to)}</mark>);
    pos = to;
  });
  parts.push(text.slice(pos));
  return <span className="doc-snippet">{parts}</span>;
}
