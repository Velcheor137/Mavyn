import type { Revision } from '@mdr/core';

export type HistoryRetention = 'all' | 'balanced';
export const HISTORY_RETENTION_KEY = 'history.retention';

/** UTC day buckets make the result stable across locale, timezone and DST changes. */
export function retainedRevisions(revisions: Revision[], headId: string, now: number): Set<string> {
  const sorted = [...revisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const keep = new Set([headId]);
  const initial = sorted.at(-1);
  if (initial) keep.add(initial.id);
  const days = new Set<string>();
  for (const revision of sorted) {
    const age = now - Date.parse(revision.createdAt);
    if (!Number.isFinite(age) || age <= 30 * 86_400_000) keep.add(revision.id);
    else if (age <= 365 * 86_400_000) {
      const day = revision.createdAt.slice(0, 10);
      if (!days.has(day)) { keep.add(revision.id); days.add(day); }
    }
  }
  return keep;
}
