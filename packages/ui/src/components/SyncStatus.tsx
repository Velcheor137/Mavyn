import { useTranslation } from '@mdr/i18n';
import { AlertCircle, AlertTriangle, CloudOff, CloudUpload, Loader2, RefreshCw } from 'lucide-react';
import { syncNow, useSync } from '../sync.ts';

/** Compact sync state; clicking it syncs immediately. Renders nothing when not connected. */
export function SyncStatus({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const state = useSync((s) => s.state);
  const connection = useSync((s) => s.connection);
  if (!connection || !state) return null;

  const [icon, label, tone] =
    state.kind === 'synced'
      ? [<RefreshCw key="i" size={14} aria-hidden />, t('sync.synced'), 'muted']
      : state.kind === 'syncing'
        ? [<Loader2 key="i" size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />, t('sync.syncing'), 'muted']
        : state.kind === 'pending'
          ? [<CloudUpload key="i" size={14} aria-hidden />, t('sync.pending'), 'muted']
          : state.kind === 'offline'
            ? [<CloudOff key="i" size={14} aria-hidden />, t('sync.offline'), 'text-warning']
            : state.kind === 'conflict'
              ? [<AlertTriangle key="i" size={14} aria-hidden />, t('sync.conflictCount', { count: state.count }), 'text-warning']
              : [<AlertCircle key="i" size={14} aria-hidden />, `${t('sync.error')}: ${t(`errors.${state.code}` as 'errors.unknown')}`, 'text-danger'];

  return (
    <button type="button" className={`sync-status ${tone}`} onClick={() => void syncNow()} title={`${label} — ${t('sync.syncNow')}`} aria-live="polite">
      {icon}
      {!compact && <span className="truncate">{label}</span>}
    </button>
  );
}
