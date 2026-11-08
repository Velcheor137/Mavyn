import type { ErrorCode } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { toSyncAppError, type SyncApi, type UserInfo } from '@mdr/sync-client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { SetupFields } from './SetupForm.tsx';

export interface AuthenticatedUser {
  id: string;
  username: string;
  is_admin: boolean;
}

type GateState = { kind: 'checking' } | { kind: 'setup' } | { kind: 'login' } | { kind: 'unavailable' };

/**
 * Full-page sign-in for the web app served by a Mavyn server. Nothing of the app or the local
 * library renders until the visitor is authenticated. A device that signed in before may continue
 * offline with its own local library (`remembered`), because that data is already on the device.
 */
export function AuthGate({
  api,
  health,
  remembered,
  onAuthenticated,
}: {
  api: SyncApi;
  health(): Promise<boolean>;
  remembered: AuthenticatedUser | null;
  onAuthenticated(user: AuthenticatedUser, offline: boolean): void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<GateState>({ kind: 'checking' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const check = useCallback(async () => {
    setState({ kind: 'checking' });
    setError(null);
    if (!(await health())) {
      if (remembered) onAuthenticated(remembered, true);
      else setState({ kind: 'unavailable' });
      return;
    }
    try {
      if (await api.needsSetup()) return setState({ kind: 'setup' });
      const me = await api.me();
      onAuthenticated(toUser(me), false);
    } catch (e) {
      const code = toSyncAppError(e).code;
      if (code === 'auth.required') setState({ kind: 'login' });
      else if (code === 'sync.offline' && remembered) onAuthenticated(remembered, true);
      else {
        setError(code);
        setState({ kind: 'unavailable' });
      }
    }
  }, [api, health, remembered, onAuthenticated]);

  useEffect(() => {
    void check();
  }, [check]);

  const signIn = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api.login(username.trim(), password);
      setPassword('');
      onAuthenticated(toUser(me), false);
    } catch (err) {
      setError(toSyncAppError(err).code);
    } finally {
      setBusy(false);
    }
  };

  const setup = async (token: string, name: string, pass: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await api.setup(token, name, pass);
      const me = await api.login(name, pass);
      onAuthenticated(toUser(me), false);
      return true;
    } catch (err) {
      const code = toSyncAppError(err).code;
      setError(code);
      if (code === 'setup.already_completed') setState({ kind: 'login' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand">
          <img src="/icon.svg" alt="" width={40} height={40} />
          <h1 id="auth-title">{t('app.name')}</h1>
        </div>
        {state.kind === 'checking' && <p className="muted">{t('app.loading')}</p>}
        {state.kind === 'unavailable' && (
          <div className="grid gap-3">
            <p>{t('auth.unavailable')}</p>
            {error && <p className="text-danger small" role="alert">{t(`errors.${error}` as 'errors.unknown')}</p>}
            <button type="button" className="button justify-self-start" onClick={() => void check()}>
              {t('auth.retry')}
            </button>
          </div>
        )}
        {state.kind === 'setup' && (
          <>
            <h2 className="auth-subtitle">{t('setup.title')}</h2>
            <SetupFields busy={busy} error={error} submit={setup} />
          </>
        )}
        {state.kind === 'login' && (
          <form className="grid gap-3" onSubmit={(e) => void signIn(e)}>
            <h2 className="auth-subtitle">{t('auth.title')}</h2>
            <label className="field" htmlFor="auth-username">
              <span className="field-label">{t('sync.username')}</span>
              <input id="auth-username" className="input" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.currentTarget.value)} required />
            </label>
            <label className="field" htmlFor="auth-password">
              <span className="field-label">{t('sync.password')}</span>
              <input id="auth-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} required />
            </label>
            {error && <p className="text-danger small" role="alert">{t(`errors.${error}` as 'errors.unknown')}</p>}
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? t('sync.signingIn') : t('sync.signIn')}
            </button>
            <p className="muted small">{t('auth.hint')}</p>
          </form>
        )}
      </section>
    </main>
  );
}

function toUser(me: UserInfo): AuthenticatedUser {
  return { id: me.id, username: me.username, is_admin: me.is_admin };
}
