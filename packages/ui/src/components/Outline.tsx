import { useTranslation } from '@mdr/i18n';
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useRendered, useSession } from '../hooks.ts';
import { updateDocument, useWorkspace } from '../workspace.ts';

/** Right panel: table of contents, document statistics, tags. */
export function Outline({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const session = useSession(id);
  const meta = useWorkspace((s) => s.documents.find((d) => d.id === id));
  const { result } = useRendered(session?.text, 400);
  const [tagInput, setTagInput] = useState('');

  const stats = useMemo(() => {
    const text = session?.text ?? '';
    const words = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
    return { words, minutes: Math.max(1, Math.round(words / 200)) };
  }, [session?.text]);

  if (!session || !meta) return null;
  const tasks = result?.tasks ?? [];
  const done = tasks.filter((task) => task.checked).length;
  const dateFormat = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const scrollTo = (headingId: string) => {
    const reader = document.querySelector<HTMLElement>('[data-reader-scroll]');
    reader?.querySelector(`[id="${CSS.escape(headingId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag) void updateDocument(id, { tags: [...meta.tags, tag] });
    setTagInput('');
  };

  return (
    <aside className="outline" aria-label={t('document.toc')}>
      <section>
        <h2 className="panel-heading">{t('document.toc')}</h2>
        {result && result.toc.length === 0 && <p className="muted small">{t('document.noHeadings')}</p>}
        <ul className="toc">
          {result?.toc.map((entry) => (
            <li key={entry.id} style={{ paddingInlineStart: `${(entry.depth - 1) * 12}px` }}>
              <button type="button" className="toc-item" onClick={() => scrollTo(entry.id)}>
                {entry.text}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="panel-heading">{t('document.details')}</h2>
        <dl className="details">
          <dt>{t('document.words', { count: stats.words })}</dt>
          <dd>{t('document.readingTime', { count: stats.minutes })}</dd>
          {tasks.length > 0 && (
            <>
              <dt className="sr-only">{t('document.tasksProgress', { done, total: tasks.length })}</dt>
              <dd>
                <span>{t('document.tasksProgress', { done, total: tasks.length })}</span>
                <progress className="task-progress" value={done} max={tasks.length} />
              </dd>
            </>
          )}
          <dt>{t('document.created')}</dt>
          <dd>{dateFormat.format(new Date(meta.createdAt))}</dd>
          <dt>{t('document.updated')}</dt>
          <dd>{dateFormat.format(new Date(meta.updatedAt))}</dd>
          <dt className="sr-only">{t('document.source_imported')}</dt>
          <dd className="muted">{meta.source.kind === 'linked' ? t('document.source_linked') : t('document.source_imported')}</dd>
        </dl>
      </section>

      <section>
        <h2 className="panel-heading">{t('document.tags')}</h2>
        <ul className="tag-list">
          {meta.tags.map((tag) => (
            <li key={tag} className="tag">
              #{tag}
              <button type="button" className="tag-remove" onClick={() => void updateDocument(id, { tags: meta.tags.filter((x) => x !== tag) })} aria-label={t('document.removeTag', { tag })}>
                <X size={11} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <input
          className="input small"
          value={tagInput}
          placeholder={t('document.addTag')}
          aria-label={t('document.addTag')}
          onChange={(e) => setTagInput(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTag()}
          onBlur={addTag}
        />
      </section>
    </aside>
  );
}
