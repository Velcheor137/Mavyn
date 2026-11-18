import { TEXT_ENCODINGS, type DocumentMeta } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { useId, useState } from 'react';
import { canReopenWithEncoding, reopenWithEncoding, setSaveEncoding } from '../workspace.ts';
import { Field, Modal } from './primitives.tsx';

/** Display name of a WHATWG encoding label (`windows-1251` → `WINDOWS-1251`). */
export function encodingName(label: string | undefined): string {
  return (label ?? 'utf-8').toUpperCase();
}

/**
 * Reopen a text file with another encoding (when detection guessed wrong) or save it in another one.
 * Reopening needs the original bytes: a linked file, or an imported copy not edited yet.
 */
export function EncodingDialog({ meta, onClose }: { meta: DocumentMeta; onClose(): void }) {
  const { t } = useTranslation();
  const id = useId();
  const current = meta.encoding ?? 'utf-8';
  const [encoding, setEncoding] = useState<string>(current);
  const [busy, setBusy] = useState(false);
  const canReopen = canReopenWithEncoding(meta);
  const options: string[] = TEXT_ENCODINGS.includes(current as (typeof TEXT_ENCODINGS)[number]) ? [...TEXT_ENCODINGS] : [current, ...TEXT_ENCODINGS];

  const run = async (action: (id: string, encoding: string) => Promise<void>) => {
    setBusy(true);
    await action(meta.id, encoding);
    setBusy(false);
    onClose();
  };

  return (
    <Modal open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={t('encoding.title')} description={t('encoding.current', { encoding: encodingName(current) })} closeLabel={t('folders.cancel')}>
      <div className="grid gap-3">
        <Field label={t('encoding.label')} htmlFor={`${id}-encoding`}>
          <select id={`${id}-encoding`} className="input" value={encoding} onChange={(event) => setEncoding(event.currentTarget.value)} disabled={busy}>
            {options.map((label) => <option key={label} value={label}>{encodingName(label)}</option>)}
          </select>
        </Field>
        <p className="muted small">{canReopen ? t('encoding.reopenHint') : t('encoding.reopenUnavailable')}</p>
        <p className="muted small">{t('encoding.saveHint')}</p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button type="button" className="button" disabled={busy} onClick={onClose}>{t('folders.cancel')}</button>
          {canReopen && (
            <button type="button" className="button" disabled={busy} onClick={() => void run(reopenWithEncoding)}>
              {t('encoding.reopen')}
            </button>
          )}
          <button type="button" className="button button-primary" disabled={busy || encoding === current} onClick={() => void run(setSaveEncoding)}>
            {t('encoding.save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
