import type { FormatCommand } from '@mdr/editor';
import { useTranslation } from '@mdr/i18n';
import { Bold, Code, Heading, Image, Italic, Link, List, ListChecks, Quote, Strikethrough } from 'lucide-react';
import type { ReactNode } from 'react';

const ITEMS: Array<[FormatCommand, ReactNode, string?]> = [
  ['bold', <Bold key="b" size={15} aria-hidden />, 'Ctrl+B'],
  ['italic', <Italic key="i" size={15} aria-hidden />, 'Ctrl+I'],
  ['strikethrough', <Strikethrough key="s" size={15} aria-hidden />],
  ['heading', <Heading key="h" size={15} aria-hidden />],
  ['quote', <Quote key="q" size={15} aria-hidden />],
  ['bulletList', <List key="l" size={15} aria-hidden />],
  ['taskList', <ListChecks key="t" size={15} aria-hidden />],
  ['code', <Code key="c" size={15} aria-hidden />],
  ['link', <Link key="k" size={15} aria-hidden />, 'Ctrl+K'],
  ['image', <Image key="m" size={15} aria-hidden />],
];

export function EditorToolbar({ onFormat }: { onFormat(command: FormatCommand): void }) {
  const { t } = useTranslation();
  return (
    <div className="editor-toolbar" role="toolbar" aria-label={t('editor.toolbar')}>
      {ITEMS.map(([command, icon, shortcut]) => {
        const label = t(`editor.${command}`);
        return (
          <button
            key={command}
            type="button"
            className="icon-button"
            // Keep focus (and selection) in the editor.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onFormat(command)}
            aria-label={label}
            title={shortcut ? `${label} (${shortcut})` : label}
          >
            {icon}
          </button>
        );
      })}
    </div>
  );
}
