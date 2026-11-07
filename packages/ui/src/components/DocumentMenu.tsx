import type { DocumentMeta, DocumentSession } from '@mdr/core';
import { encodeUtf8 } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { renderToHtml } from '@mdr/markdown-engine';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { FileCode, FileDown, MoreHorizontal, Pencil, Printer, Star, StarOff, Trash2 } from 'lucide-react';
import { usePreferences } from '../preferences.ts';
import { useServices } from '../services.tsx';
import { trashDocument, updateDocument } from '../workspace.ts';
import { buildStandaloneHtml } from '../export.ts';

export function DocumentMenu({ meta, session }: { meta: DocumentMeta; session: DocumentSession }) {
  const { t } = useTranslation();
  const { platform } = useServices();
  const profile = usePreferences((p) => p.profile);
  const allowHtml = usePreferences((p) => p.allowHtml);
  const baseName = meta.fileName.replace(/\.[^.]+$/, '') || 'document';

  const exportMarkdown = () => void platform.saveAs(`${baseName}.md`, encodeUtf8({ text: session.text, bom: meta.bom }), 'text/markdown;charset=utf-8');
  const exportHtml = () => {
    const body = renderToHtml(session.text, { profile, allowHtml });
    const html = buildStandaloneHtml(meta.title, body, document.documentElement.lang || 'en');
    void platform.saveAs(`${baseName}.html`, new TextEncoder().encode(html), 'text/html;charset=utf-8');
  };
  const rename = () => {
    const title = window.prompt(t('document.rename'), meta.fileName);
    if (title && title.trim()) void updateDocument(meta.id, { fileName: title.trim() });
  };

  return (
    <Menu.Root>
      <Menu.Trigger className="icon-button" aria-label={t('document.more')} title={t('document.more')}>
        <MoreHorizontal size={16} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="end" sideOffset={6}>
          <Menu.Item className="menu-item" onSelect={() => void updateDocument(meta.id, { favorite: !meta.favorite })}>
            {meta.favorite ? <StarOff size={15} aria-hidden /> : <Star size={15} aria-hidden />}
            {meta.favorite ? t('document.unfavorite') : t('document.favorite')}
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={rename}>
            <Pencil size={15} aria-hidden />
            {t('document.rename')}
          </Menu.Item>
          <Menu.Separator className="menu-separator" />
          <Menu.Label className="menu-label">{t('document.export')}</Menu.Label>
          <Menu.Item className="menu-item" onSelect={exportMarkdown}>
            <FileDown size={15} aria-hidden />
            {t('document.exportMarkdown')}
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={exportHtml}>
            <FileCode size={15} aria-hidden />
            {t('document.exportHtml')}
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => window.print()}>
            <Printer size={15} aria-hidden />
            {t('document.print')}
          </Menu.Item>
          <Menu.Separator className="menu-separator" />
          <Menu.Item className="menu-item menu-item-danger" onSelect={() => void trashDocument(meta.id)}>
            <Trash2 size={15} aria-hidden />
            {t('document.moveToTrash')}
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
