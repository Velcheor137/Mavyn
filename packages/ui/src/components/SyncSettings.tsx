import { useTranslation } from '@mdr/i18n';
import { useState, type FormEvent } from 'react';
import { useRelativeTime } from '../hooks.ts';
import { configureSyncServer, connectLibrary, signIn, signOut, syncNow, useSync } from '../sync.ts';
import { useServices } from '../services.tsx';
import { SetupForm } from './SetupForm.tsx';
import { SyncStatus } from './SyncStatus.tsx';

/** Settings section: sign in to the server serving this app and choose the library to sync. */
export function SyncSettings({ showSignOut = true }: { showSignOut?: boolean }) {
  return <div className="grid gap-3"><ServerAddress /><SyncAccountSettings showSignOut={showSignOut} /></div>;
}

function ServerAddress() {
  const { t } = useTranslation();
  const services = useServices();
  const { user, busy, available, error } = useSync();
  const [url, setUrl] = useState(services.server?.baseUrl ?? '');
  if (!services.configureServer) return null;
  if (user) return <p className="muted small">{services.server?.baseUrl}</p>;
  return <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void configureSyncServer(url); }}>
    <label className="field" htmlFor="sync-server-url">
      <span className="field-label">{t('sync.serverAddress')}</span>
      <input id="sync-server-url" className="input" type="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        placeholder={t('sync.serverPlaceholder')} value={url} onChange={(event) => setUrl(event.currentTarget.value)} />
    </label>
    <p className="muted small">{t('sync.serverAddressHint')}</p>
    <button type="submit" className="button justify-self-start" disabled={busy}>{t('sync.saveServer')}</button>
    {!available && error && <p className="text-danger small" role="alert">{t(`errors.${error}` as 'errors.unknown')}</p>}
  </form>;
}

function SyncAccountSettings({ showSignOut }: { showSignOut: boolean }) {
  const { t } = useTranslation();
  const { platform } = useServices();
  const { available, needsSetup, user, connection, libraries, busy, error, state } = useSync();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [choice, setChoice] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [removeCopies, setRemoveCopies] = useState(false);

  const errorText = error ? <p className="text-danger small" role="alert">{t(`errors.${error}` as 'errors.unknown')}</p> : null;

  if (available === null) return <p className="muted">{t('sync.checking')}</p>;
  if (!available) return <p className="muted">{t(platform.kind === 'web' ? 'sync.noServer' : 'sync.noNativeServer')}</p>;
  if (needsSetup) return <SetupForm />;

  if (!user) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      void signIn(username, password).then(() => setPassword(''));
    };
    return (
      <form className="grid gap-2" onSubmit={submit}>
        <p className="muted small">{t('sync.signInHint')}</p>
        <label className="field" htmlFor="sync-username">
          <span className="field-label">{t('sync.username')}</span>
          <input id="sync-username" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} required />
        </label>
        <label className="field" htmlFor="sync-password">
          <span className="field-label">{t('sync.password')}</span>
          <input id="sync-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} required />
        </label>
        {errorText}
        <button type="submit" className="button button-primary justify-self-start" disabled={busy}>
          {busy ? t('sync.signingIn') : t('sync.signIn')}
        </button>
      </form>
    );
  }

  return (
    <div className="grid gap-3">
      <p>{t('sync.signedInAs', { username: user.username })}</p>
      {connection ? (
        <>
          <p>{t('sync.connectedTo', { library: connection.libraryName })}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <SyncStatus />
            <button type="button" className="button" onClick={() => void syncNow()}>
              {t('sync.syncNow')}
            </button>
            {state?.kind === 'synced' && <LastSynced at={state.at} />}
          </div>
        </>
      ) : (
        <div className="grid gap-2">
          <p className="field-label">{t('sync.chooseLibrary')}</p>
          <div role="radiogroup" aria-label={t('sync.chooseLibrary')}>
            {libraries.map((lib) => (
              <label key={lib.id} className="switch-row" htmlFor={`sync-lib-${lib.id}`}>
                <span>
                  {lib.name} <span className="muted small">· {t(`sync.role_${lib.role}`)}</span>
                </span>
                <input
                  id={`sync-lib-${lib.id}`}
                  type="radio"
                  name="sync-library"
                  aria-label={`${lib.name} · ${t(`sync.role_${lib.role}`)}`}
                  checked={choice === lib.id}
                  onChange={() => setChoice(lib.id)}
                />
              </label>
            ))}
            <label className="switch-row" htmlFor="sync-lib-new">
              <span>{t('sync.newLibrary')}</span>
              <input id="sync-lib-new" type="radio" name="sync-library" aria-label={t('sync.newLibrary')} checked={choice === 'new'} onChange={() => setChoice('new')} />
            </label>
          </div>
          {choice === 'new' && <input className="input" value={newName} aria-label={t('sync.newLibraryName')} placeholder={t('sync.newLibraryName')} onChange={(e) => setNewName(e.currentTarget.value)} />}
          <button
            type="button"
            className="button button-primary justify-self-start"
            disabled={busy || !choice || (choice === 'new' && !newName.trim())}
            onClick={() => void connectLibrary(choice === 'new' ? { newName: newName.trim() } : { libraryId: choice })}
          >
            {t('sync.connect')}
          </button>
          <p className="muted small">{t('sync.folderHint')}</p>
        </div>
      )}
      {errorText}
      {showSignOut && <div className="grid gap-1 border-t pt-3" style={{ borderColor: 'var(--color-border)' }}>
        <label className="switch-row" htmlFor="sync-remove-copies">
          <span>{t('sync.removeCopies')}</span>
          <input id="sync-remove-copies" type="checkbox" aria-label={t('sync.removeCopies')} checked={removeCopies} onChange={(e) => setRemoveCopies(e.currentTarget.checked)} />
        </label>
        <p className="muted small">{t('sync.pendingKept')}</p>
        <button type="button" className="button justify-self-start" disabled={busy} onClick={() => void signOut(removeCopies)}>
          {t('sync.signOut')}
        </button>
      </div>}
    </div>
  );
}

export function LastSynced({ at }: { at: number }) {
  const { t, i18n } = useTranslation();
  const relative = useRelativeTime(i18n.language);
  return <span className="muted small">{t('sync.lastSynced', { time: relative(new Date(at).toISOString()) })}</span>;
}
