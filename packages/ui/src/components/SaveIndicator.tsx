import type { SessionSaveState } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { AlertCircle, Check, Circle, Loader2 } from 'lucide-react';

export function SaveIndicator({ state }: { state: SessionSaveState }) {
  const { t } = useTranslation();
  const [icon, label, tone] =
    state.kind === 'saved'
      ? [<Check key="i" size={14} aria-hidden />, t('save.saved'), 'muted']
      : state.kind === 'saving'
        ? [<Loader2 key="i" size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />, t('save.saving'), 'muted']
        : state.kind === 'dirty'
          ? [<Circle key="i" size={10} fill="currentColor" aria-hidden />, t('save.unsaved'), 'muted']
          : state.kind === 'conflict'
            ? [<AlertCircle key="i" size={14} aria-hidden />, t('save.conflict'), 'text-warning']
            : [<AlertCircle key="i" size={14} aria-hidden />, `${t('save.error')}: ${t(`errors.${state.code}` as 'errors.unknown')}`, 'text-danger'];
  return (
    <span className={`save-indicator ${tone}`} role="status" aria-live="polite" title={label}>
      {icon}
      <span className="hidden md:inline">{label}</span>
    </span>
  );
}
