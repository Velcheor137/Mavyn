import { toAppError, type ErrorCode } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import type { HistoryRetention } from '@mdr/storage';
import { useEffect, useId, useState } from 'react';
import { useServices } from '../services.tsx';
import { Field, Modal } from './primitives.tsx';

export function HistorySettings() {
  const { t } = useTranslation();
  const { library } = useServices();
  const id = useId();
  const [policy, setPolicy] = useState<HistoryRetention>('all');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [removed, setRemoved] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    library.getHistoryRetention().then((value) => { if (current) { setPolicy(value); setReady(true); } }, (cause) => { if (current) setError(toAppError(cause).code); });
    return () => { current = false; };
  }, [library]);
  const change = async (next: HistoryRetention) => {
    setBusy(true); setError(null); setRemoved(null);
    try { await library.setHistoryRetention(next); setPolicy(next); }
    catch (cause) { setError(toAppError(cause).code); }
    finally { setBusy(false); }
  };
  const cleanup = async () => {
    setBusy(true); setError(null);
    try { setRemoved(await library.pruneHistory()); setConfirm(false); }
    catch (cause) { setError(toAppError(cause).code); }
    finally { setBusy(false); }
  };
  return <>
    <Field label={t('history.retention')} htmlFor={id}>
      <select id={id} className="input" value={policy} disabled={!ready || busy} onChange={(event) => void change(event.currentTarget.value as HistoryRetention)}>
        <option value="all">{t('history.keepAll')}</option>
        <option value="balanced">{t('history.balanced')}</option>
      </select>
    </Field>
    <p className="muted small">{t('history.retentionHint')}</p>
    <button type="button" className="button" disabled={!ready || busy || policy === 'all'} onClick={() => setConfirm(true)}>{t('history.cleanup')}</button>
    {removed !== null && <p role="status" className="muted small">{t('history.removed', { count: removed })}</p>}
    {error && !confirm && <p role="alert" className="text-danger small">{t(`errors.${error}` as 'errors.unknown')}</p>}
    <Modal open={confirm} onOpenChange={(open) => { if (!busy) setConfirm(open); }} title={t('history.confirmTitle')} closeLabel={t('folders.cancel')}>
      <p>{t('history.confirmHint')}</p>
      {error && <p role="alert" className="text-danger small">{t(`errors.${error}` as 'errors.unknown')}</p>}
      <div className="flex gap-2 justify-end mt-3">
        <button type="button" className="button" disabled={busy} onClick={() => setConfirm(false)}>{t('folders.cancel')}</button>
        <button type="button" className="button button-primary" disabled={busy} onClick={() => void cleanup()}>{t('history.confirmAction')}</button>
      </div>
    </Modal>
  </>;
}
