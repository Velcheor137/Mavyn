import { toAppError, type ErrorCode } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { useId, useState, type FormEvent } from 'react';
import { createTextFile } from '../workspace.ts';
import { Field, Modal } from './primitives.tsx';

/** Asks for the name of a new plain text or code file (any extension). */
export function NewFileDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState('untitled.txt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createTextFile(name);
      onClose();
    } catch (cause) {
      setError(toAppError(cause).code);
      setBusy(false);
    }
  };

  return (
    <Modal open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={t('newFile.title')} closeLabel={t('folders.cancel')}>
      <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
        <Field label={t('document.fileName')} htmlFor={`${id}-name`}>
          <input id={`${id}-name`} className="input" value={name} onChange={(event) => setName(event.currentTarget.value)} disabled={busy} required autoFocus
            onFocus={(event) => { const dot = event.currentTarget.value.lastIndexOf('.'); event.currentTarget.setSelectionRange(0, dot > 0 ? dot : event.currentTarget.value.length); }} />
        </Field>
        <p className="muted small">{t('newFile.hint')}</p>
        {error && <p className="text-danger small" role="alert">{t(`errors.${error}` as 'errors.unknown')}</p>}
        <div className="flex gap-2 justify-end">
          <button type="button" className="button" disabled={busy} onClick={onClose}>{t('folders.cancel')}</button>
          <button type="submit" className="button button-primary" disabled={busy || !name.trim()}>{t('newFile.create')}</button>
        </div>
      </form>
    </Modal>
  );
}
