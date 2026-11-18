import { splitLinesKeepEnds } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { AlertTriangle } from 'lucide-react';
import { diffComm } from 'node-diff3';
import { useState } from 'react';
import { resolveConflict, serverFile, serverText } from '../sync.ts';
import { getSession, notifyError } from '../workspace.ts';

/** Shown on documents whose local edits and a newer server version could not be merged. */
export function SyncConflictBanner({ id }: { id: string }) {
  const { t } = useTranslation();
  const [theirs, setTheirs] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resolve = async (resolution: 'mine' | 'server' | 'both') => {
    setBusy(true);
    await resolveConflict(id, resolution, t('sync.myCopy'));
    setBusy(false);
  };

  const toggleServer = async () => {
    if (theirs !== null) return setTheirs(null);
    try {
      setTheirs(await serverText(id));
    } catch (error) {
      notifyError(error);
    }
  };

  const ours = getSession(id)?.text ?? '';
  return (
    <div className="banner banner-warning" role="alert">
      <AlertTriangle size={16} aria-hidden className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <strong>{t('sync.conflictTitle')}</strong>
        <p>{t('sync.conflictDescription')}</p>
        <p className="muted small">{t('sync.keepBothHint')}</p>
        <p className="muted small">{t('sync.useServerHint')}</p>
        <button type="button" className="link-button small" onClick={() => void toggleServer()} aria-expanded={theirs !== null}>
          {theirs === null ? t('sync.showServer') : t('sync.hideServer')}
        </button>
        {theirs !== null && (
          <pre className="diff" aria-label={t('sync.compare')}>
            {diffComm(splitLinesKeepEnds(theirs), splitLinesKeepEnds(ours)).map((part, i) =>
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
        )}
      </div>
      <div className="flex flex-wrap gap-2 items-start">
        <button type="button" className="button" disabled={busy} onClick={() => void resolve('server')}>
          {t('sync.useServer')}
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => void resolve('both')}>
          {t('sync.keepBoth')}
        </button>
        <button type="button" className="button button-primary" disabled={busy} onClick={() => void resolve('mine')}>
          {t('sync.keepMine')}
        </button>
      </div>
    </div>
  );
}

/**
 * Conflict of a binary document edited on two devices. Files are never merged: the user opens the
 * other version (read-only, in the viewer) and keeps one of them or both.
 */
export function FileConflictBanner({ id, showingOther, onShowOther }: { id: string; showingOther: boolean; onShowOther(bytes: Uint8Array | null): void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const resolve = async (resolution: 'mine' | 'server' | 'both') => {
    setBusy(true);
    onShowOther(null);
    await resolveConflict(id, resolution, t('sync.myCopy'));
    setBusy(false);
  };

  const toggleOther = async () => {
    if (showingOther) return onShowOther(null);
    try {
      onShowOther(await serverFile(id));
    } catch (error) {
      notifyError(error);
    }
  };

  return (
    <div className="banner banner-warning" role="alert">
      <AlertTriangle size={16} aria-hidden className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <strong>{t('sync.conflictTitle')}</strong>
        <p>{t('files.conflictDescription')}</p>
        <p className="muted small">{t('sync.keepBothHint')}</p>
        <p className="muted small">{t('files.useServerHint')}</p>
        <button type="button" className="link-button small" onClick={() => void toggleOther()} aria-pressed={showingOther}>
          {showingOther ? t('files.hideOther') : t('files.showOther')}
        </button>
      </div>
      <div className="flex flex-wrap gap-2 items-start">
        <button type="button" className="button" disabled={busy} onClick={() => void resolve('server')}>
          {t('sync.useServer')}
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => void resolve('both')}>
          {t('sync.keepBoth')}
        </button>
        <button type="button" className="button button-primary" disabled={busy} onClick={() => void resolve('mine')}>
          {t('sync.keepMine')}
        </button>
      </div>
    </div>
  );
}
