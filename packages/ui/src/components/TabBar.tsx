import { useTranslation } from '@mdr/i18n';
import { X } from 'lucide-react';
import { closeTab, getSession, openDocument, useWorkspace } from '../workspace.ts';

export function TabBar() {
  const { t } = useTranslation();
  const tabs = useWorkspace((s) => s.tabs);
  const active = useWorkspace((s) => s.active);
  const documents = useWorkspace((s) => s.documents);
  useWorkspace((s) => s.sessionTick);
  if (tabs.length === 0) return null;
  return (
    <div className="tab-bar" role="tablist" aria-label={t('a11y.documentTabs')}>
      {tabs.map((id) => {
        const doc = documents.find((d) => d.id === id);
        const title = doc?.title || t('document.untitled');
        const dirty = getSession(id)?.saveState.kind === 'dirty';
        return (
          <div key={id} className={`tab ${active === id ? 'active' : ''}`} onAuxClick={(e) => e.button === 1 && void closeTab(id)}>
            <button type="button" role="tab" aria-selected={active === id} className="tab-label" onClick={() => void openDocument(id)} title={title}>
              <span className="truncate">{title}</span>
              {dirty && <span className="tab-dirty" aria-label={t('save.unsaved')} />}
            </button>
            <button type="button" className="tab-close" onClick={() => void closeTab(id)} aria-label={t('document.closeTab', { title })}>
              <X size={13} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
