import { useTranslation } from '@mdr/i18n';
import { toSyncAppError, type ApiTokenInfo, type CreatedApiToken, type LibraryInfo, type SyncApi, type TokenApi } from '@mdr/sync-client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRelativeTime } from '../hooks.ts';

type Expiry = '30' | '90' | '365' | 'never';

/**
 * Settings section of the web app (server administrators only): API keys for scripts and MCP
 * clients. A new key is shown once, with the command that connects Claude Code to `/mcp`.
 */
export function ApiTokens({ api, origin }: { api: SyncApi & TokenApi; origin: string }) {
  const { t, i18n } = useTranslation();
  const relative = useRelativeTime(i18n.language);
  const [tokens, setTokens] = useState<ApiTokenInfo[] | null>(null);
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const fail = (e: unknown) => setError(toSyncAppError(e).code);

  // Libraries are reloaded whenever the form opens: one may have been created meanwhile.
  useEffect(() => {
    let live = true;
    Promise.all([api.listTokens(), api.listLibraries()])
      .then(([list, libs]) => {
        if (!live) return;
        setTokens(list);
        setLibraries(libs);
      })
      .catch((e: unknown) => live && fail(e));
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => {
    if (!creating) return;
    let live = true;
    api
      .listLibraries()
      .then((libs) => live && setLibraries(libs))
      .catch((e: unknown) => live && fail(e));
    return () => {
      live = false;
    };
  }, [api, creating]);

  const revoke = async (id: string) => {
    setError(null);
    try {
      await api.revokeToken(id);
      setTokens((list) => (list ?? []).filter((token) => token.id !== id));
      setRevoking(null);
    } catch (e) {
      fail(e);
    }
  };

  const libraryNames = (token: ApiTokenInfo) =>
    token.all_libraries
      ? t('apiKeys.allLibrariesShort')
      : token.library_ids.map((id) => libraries.find((l) => l.id === id)?.name ?? '—').join(', ');
  const accessText = (token: ApiTokenInfo) =>
    t(token.access === 'read' ? 'apiKeys.accessRead' : token.can_delete ? 'apiKeys.accessDelete' : 'apiKeys.accessWrite');
  const date = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(iso));

  return (
    <div className="grid gap-3">
      <p className="muted small">{t('apiKeys.intro')}</p>
      {error && <p className="text-danger small" role="alert">{t(`errors.${error}` as 'errors.unknown')}</p>}

      {created ? (
        <CreatedKey created={created} origin={origin} onDone={() => setCreated(null)} />
      ) : creating ? (
        <CreateForm
          api={api}
          libraries={libraries}
          onCancel={() => setCreating(false)}
          onCreated={(result) => {
            setTokens((list) => [result.info, ...(list ?? [])]);
            setCreating(false);
            setCreated(result);
          }}
        />
      ) : (
        <button type="button" className="button justify-self-start" onClick={() => { setError(null); setCreating(true); }}>
          {t('apiKeys.create')}
        </button>
      )}

      {tokens === null ? null : tokens.length === 0 ? (
        <p className="muted small">{t('apiKeys.empty')}</p>
      ) : (
        <ul className="api-keys" aria-label={t('apiKeys.title')}>
          {tokens.map((token) => (
            <li key={token.id} className="api-key">
              <div className="grid gap-1">
                <strong>{token.name}</strong>
                <code className="small">mvn_…{token.hint}</code>
                <span className="muted small">
                  {accessText(token)} · {libraryNames(token)}
                </span>
                <span className="muted small">
                  {token.last_used_at ? t('apiKeys.lastUsed', { time: relative(token.last_used_at) }) : t('apiKeys.neverUsed')}
                  {' · '}
                  {token.expires_at ? t('apiKeys.expires', { date: date(token.expires_at) }) : t('apiKeys.noExpiry')}
                </span>
              </div>
              {revoking === token.id ? (
                <div className="grid gap-2 justify-items-end">
                  <span className="small">{t('apiKeys.revokeConfirm', { name: token.name })}</span>
                  <div className="flex gap-2">
                    <button type="button" className="button" onClick={() => setRevoking(null)}>{t('apiKeys.cancel')}</button>
                    <button type="button" className="button button-danger" onClick={() => void revoke(token.id)}>{t('apiKeys.revoke')}</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="button" onClick={() => setRevoking(token.id)} aria-label={t('apiKeys.revokeNamed', { name: token.name })}>
                  {t('apiKeys.revoke')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateForm({
  api,
  libraries,
  onCancel,
  onCreated,
}: {
  api: TokenApi;
  libraries: LibraryInfo[];
  onCancel(): void;
  onCreated(result: CreatedApiToken): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const [canDelete, setCanDelete] = useState(false);
  const [expiry, setExpiry] = useState<Expiry>('90');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim().length > 0 && (all || selected.length > 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await api.createToken({
          name: name.trim(),
          access,
          can_delete: access === 'write' && canDelete,
          all_libraries: all,
          library_ids: all ? [] : selected,
          expires_in_days: expiry === 'never' ? null : (Number(expiry) as 30 | 90 | 365),
        }),
      );
    } catch (e) {
      setError(toSyncAppError(e).code);
      setBusy(false);
    }
  };

  return (
    <form className="grid gap-3 api-key-form" onSubmit={(e) => void submit(e)}>
      <label className="field" htmlFor="api-key-name">
        <span className="field-label">{t('apiKeys.name')}</span>
        <input id="api-key-name" className="input" maxLength={100} placeholder={t('apiKeys.namePlaceholder')} value={name} onChange={(e) => setName(e.currentTarget.value)} required />
      </label>

      <fieldset className="grid gap-1">
        <legend className="field-label">{t('apiKeys.libraries')}</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.currentTarget.checked)} />
          {t('apiKeys.allLibraries')}
        </label>
        {!all &&
          libraries.map((library) => (
            <label key={library.id} className="flex items-center gap-2 ps-5">
              <input
                type="checkbox"
                checked={selected.includes(library.id)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setSelected((list) => (on ? [...list, library.id] : list.filter((id) => id !== library.id)));
                }}
              />
              {library.name}
            </label>
          ))}
      </fieldset>

      <fieldset className="grid gap-1">
        <legend className="field-label">{t('apiKeys.access')}</legend>
        {(['read', 'write'] as const).map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input type="radio" name="api-key-access" checked={access === value} onChange={() => setAccess(value)} />
            {t(value === 'read' ? 'apiKeys.read' : 'apiKeys.write')}
          </label>
        ))}
        {access === 'write' && (
          <label className="flex items-center gap-2 ps-5">
            <input type="checkbox" checked={canDelete} onChange={(e) => setCanDelete(e.currentTarget.checked)} />
            {t('apiKeys.allowDelete')}
          </label>
        )}
      </fieldset>

      <label className="field" htmlFor="api-key-expiry">
        <span className="field-label">{t('apiKeys.expiry')}</span>
        <select id="api-key-expiry" className="input" value={expiry} onChange={(e) => setExpiry(e.currentTarget.value as Expiry)}>
          <option value="30">{t('apiKeys.days', { count: 30 })}</option>
          <option value="90">{t('apiKeys.days', { count: 90 })}</option>
          <option value="365">{t('apiKeys.days', { count: 365 })}</option>
          <option value="never">{t('apiKeys.never')}</option>
        </select>
      </label>

      {error && <p className="text-danger small" role="alert">{t(`errors.${error}` as 'errors.unknown')}</p>}
      <div className="flex gap-2">
        <button type="submit" className="button button-primary" disabled={busy || !valid}>{t('apiKeys.create')}</button>
        <button type="button" className="button" onClick={onCancel}>{t('apiKeys.cancel')}</button>
      </div>
    </form>
  );
}

function CreatedKey({ created, origin, onDone }: { created: CreatedApiToken; origin: string; onDone(): void }) {
  const { t } = useTranslation();
  const command = `claude mcp add --transport http mavyn ${origin.replace(/\/+$/, '')}/mcp --header "Authorization: Bearer ${created.token}"`;
  return (
    <div className="grid gap-3 api-key-created" role="status">
      <strong>{t('apiKeys.createdTitle')}</strong>
      <p className="small">{t('apiKeys.createdHint')}</p>
      <CopyField id="api-key-value" label={t('apiKeys.key')} value={created.token} />
      <p className="small">{t('apiKeys.mcpHint')}</p>
      <CopyField id="api-key-command" label={t('apiKeys.mcpCommand')} value={command} multiline />
      <button type="button" className="button button-primary justify-self-start" onClick={onDone}>{t('apiKeys.done')}</button>
    </div>
  );
}

function CopyField({ id, label, value, multiline }: { id: string; label: string; value: string; multiline?: boolean }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard access (insecure context, denied): the field stays selectable.
      (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.select();
    }
  };
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="flex gap-2 items-start">
        {multiline ? (
          <textarea id={id} className="input api-key-secret" readOnly rows={3} value={value} onFocus={(e) => e.currentTarget.select()} />
        ) : (
          <input id={id} className="input api-key-secret" readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        )}
        <button type="button" className="button" onClick={() => void copy()}>{copied ? t('apiKeys.copied') : t('apiKeys.copy')}</button>
      </div>
    </div>
  );
}
