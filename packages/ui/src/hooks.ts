import type { DocumentSession } from '@mdr/core';
import type { RenderResult } from '@mdr/markdown-engine';
import { useEffect, useRef, useState } from 'react';
import { usePreferences } from './preferences.ts';
import { useServices } from './services.tsx';
import { getSession, useWorkspace } from './workspace.ts';

/** The session for `id`, re-rendering on every text or save-state change. */
export function useSession(id: string | null): DocumentSession | undefined {
  useWorkspace((s) => s.sessionTick);
  return id ? getSession(id) : undefined;
}

/**
 * Renders `source` (possibly in a worker), keeping the previous result visible while a newer one
 * is computed and discarding out-of-order responses. `debounceMs` batches rapid typing.
 */
export function useRendered(source: string | undefined, debounceMs: number): { result: RenderResult | null; error: unknown } {
  const { renderMarkdown } = useServices();
  const profile = usePreferences((p) => p.profile);
  const allowHtml = usePreferences((p) => p.allowHtml);
  const [state, setState] = useState<{ result: RenderResult | null; error: unknown }>({ result: null, error: null });
  const seq = useRef(0);

  useEffect(() => {
    if (source === undefined) return;
    const mine = ++seq.current;
    const timer = setTimeout(
      () => {
        renderMarkdown(source, { profile, allowHtml })
          .then((result) => mine === seq.current && setState({ result, error: null }))
          .catch((error: unknown) => mine === seq.current && setState((s) => ({ result: s.result, error })));
      },
      state.result ? debounceMs : 0,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only on input changes, not on our own result.
  }, [source, profile, allowHtml, renderMarkdown, debounceMs]);

  return state;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mql = globalThis.matchMedia?.(query);
    if (!mql) return;
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function useRelativeTime(locale: string) {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return (iso: string): string => {
    const diff = (Date.parse(iso) - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 60) return rtf.format(Math.round(diff), 'second');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
    if (abs < 30 * 86_400) return rtf.format(Math.round(diff / 86_400), 'day');
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
  };
}
