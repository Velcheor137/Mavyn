import { splitLinesKeepEnds, type Revision } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { diffComm } from 'node-diff3';
import { useEffect, useMemo, useState } from 'react';
import { useServices } from '../services.tsx';
import { getSession, notify, notifyError, reloadDocument } from '../workspace.ts';
import { Modal } from './primitives.tsx';

export function HistoryDialog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange(open: boolean): void }) {
  const { t, i18n } = useTranslation();
  const { library } = useServices();
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    library.listRevisions(id).then((list) => {
      setRevisions(list);
      setSelected(list[1]?.id ?? list[0]?.id ?? null);
    }, notifyError);
  }, [open, id, library]);

  useEffect(() => {
    setText(null);
    if (selected) library.readRevision(selected).then(setText, notifyError);
  }, [selected, library]);

  const current = getSession(id)?.text ?? '';
  const diff = useMemo(() => (text === null ? [] : diffComm(splitLinesKeepEnds(text), splitLinesKeepEnds(current))), [text, current]);
  const format = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const restore = async () => {
    if (!selected) return;
    try {
      await getSession(id)?.flush();
      await library.restoreRevision(id, selected);
      await reloadDocument(id);
      notify('history.restored');
      onOpenChange(false);
    } catch (error) {
      notifyError(error);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('history.title')} closeLabel={t('history.close')} wide>
      {revisions.length === 0 ? (
        <p className="muted">{t('history.empty')}</p>
      ) : (
        <div className="history">
          <ul className="history-list" role="listbox" aria-label={t('history.title')}>
            {revisions.map((rev, index) => (
              <li key={rev.id}>
                <button type="button" role="option" aria-selected={selected === rev.id} className={`history-item ${selected === rev.id ? 'active' : ''}`} onClick={() => setSelected(rev.id)}>
                  <span>{format.format(new Date(rev.createdAt))}</span>
                  <span className="muted small">
                    {t(`history.reason_${rev.reason}`)}
                    {index === 0 ? ` · ${t('history.current')}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="history-diff">
            <p className="muted small">{t('history.compare')}</p>
            {text !== null && diff.every((d) => d.common !== undefined) && <p>{t('history.noChanges')}</p>}
            <pre className="diff" aria-live="polite">
              {diff.map((part, i) =>
                part.common !== undefined ? (
                  <span key={i} className="diff-common">
                    {part.common.join('')}
                  </span>
                ) : (
                  <span key={i}>
                    {part.buffer1?.length ? <del className="diff-del">{part.buffer1.join('')}</del> : null}
                    {part.buffer2?.length ? <ins className="diff-ins">{part.buffer2.join('')}</ins> : null}
                  </span>
                ),
              )}
            </pre>
            <button type="button" className="button button-primary" disabled={!selected || selected === revisions[0]?.id} onClick={() => void restore()}>
              {t('history.restore')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
