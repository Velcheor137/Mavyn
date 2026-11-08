import type { ErrorCode } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { useState, type FormEvent } from 'react';
import { completeSetup, useSync } from '../sync.ts';

const LOG_COMMAND = 'docker compose logs server | grep "setup token"';

/** First-run form inside the app (Settings → Server, setup dialog), backed by the sync controller. */
export function SetupForm({ onDone }: { onDone?(): void }) {
  const busy = useSync((s) => s.busy);
  const error = useSync((s) => s.error);
  return <SetupFields busy={busy} error={error} submit={(token, username, password) => completeSetup(token, username, password)} onDone={onDone} />;
}

/**
 * First-run form: the one-time setup token from the server log plus the administrator's
 * credentials. `submit` resolves true on success.
 */
export function SetupFields({
  busy,
  error,
  submit: submitSetup,
  onDone,
}: {
  busy: boolean;
  error: ErrorCode | null;
  submit(token: string, username: string, password: string): Promise<boolean>;
  onDone?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm !== '' && confirm !== password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return;
    if (await submitSetup(token, username.trim(), password)) {
      setPassword('');
      setConfirm('');
      onDone?.();
    }
  };

  return (
    <form className="grid gap-2" onSubmit={(e) => void submit(e)}>
      <p>{t('setup.intro')}</p>
      <label className="field" htmlFor="setup-token">
        <span className="field-label">{t('setup.token')}</span>
        <input id="setup-token" className="input" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.currentTarget.value)} required />
      </label>
      <p className="muted small">
        {t('setup.tokenHint')} <code className="inline-code">{LOG_COMMAND}</code>
      </p>
      <label className="field" htmlFor="setup-username">
        <span className="field-label">{t('setup.username')}</span>
        <input id="setup-username" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} required minLength={3} maxLength={64} />
      </label>
      <label className="field" htmlFor="setup-password">
        <span className="field-label">{t('setup.password')}</span>
        <input id="setup-password" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} required minLength={10} aria-describedby="setup-password-hint" />
      </label>
      <p id="setup-password-hint" className="muted small">
        {t('setup.passwordHint')}
      </p>
      <label className="field" htmlFor="setup-confirm">
        <span className="field-label">{t('setup.confirm')}</span>
        <input
          id="setup-confirm"
          className="input"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.currentTarget.value)}
          required
          aria-invalid={mismatch}
          aria-describedby={mismatch ? 'setup-mismatch' : undefined}
        />
      </label>
      {mismatch && (
        <p id="setup-mismatch" className="text-danger small" role="alert">
          {t('setup.mismatch')}
        </p>
      )}
      {error && (
        <p className="text-danger small" role="alert">
          {t(`errors.${error}` as 'errors.unknown')}
        </p>
      )}
      <button type="submit" className="button button-primary justify-self-start" disabled={busy || mismatch}>
        {busy ? t('setup.creating') : t('setup.create')}
      </button>
    </form>
  );
}
