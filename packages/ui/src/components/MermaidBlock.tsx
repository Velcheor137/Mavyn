import { useTranslation } from '@mdr/i18n';
import { Download, Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { usePreferences, resolveTheme } from '../preferences.ts';
import { useServices } from '../services.tsx';

type State = { kind: 'loading' } | { kind: 'ok'; svg: string } | { kind: 'error'; message: string };

let queue: Promise<unknown> = Promise.resolve();

/** Mermaid keeps global state; render diagrams one at a time. */
async function renderDiagram(id: string, code: string, dark: boolean): Promise<string> {
  const run = queue.then(async () => {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      // `strict` disables click handlers/HTML labels and sanitizes the SVG with DOMPurify.
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      fontFamily: 'inherit',
    });
    const { svg } = await mermaid.render(id, code);
    return svg;
  });
  queue = run.catch(() => undefined);
  return run;
}

export function MermaidBlock({ code, line }: { code: string; line?: string | undefined }) {
  const { t } = useTranslation();
  const { platform } = useServices();
  const theme = usePreferences((p) => p.theme);
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const dark = resolveTheme(theme, globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false) === 'dark';
    setState({ kind: 'loading' });
    renderDiagram(id, code, dark)
      .then((svg) => !cancelled && setState({ kind: 'ok', svg }))
      .catch((error: unknown) => !cancelled && setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) }));
    return () => {
      cancelled = true;
    };
  }, [code, id, theme]);

  const zoom = (factor: number) => setView((v) => ({ ...v, scale: Math.min(8, Math.max(0.25, v.scale * factor)) }));
  const onPointerDown = (e: PointerEvent) => {
    drag.current = { x: e.clientX - view.x, y: e.clientY - view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (drag.current) setView((v) => ({ ...v, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y }));
  };

  if (state.kind === 'error') {
    return (
      <div className="mermaid-block mermaid-error" data-line={line} role="group" aria-label={t('mermaid.error')}>
        <strong>{t('mermaid.error')}</strong>
        <pre>{state.message}</pre>
        <pre className="mermaid-source">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <figure className="mermaid-block" data-line={line}>
      <div className="mermaid-toolbar">
        <button type="button" className="icon-button" onClick={() => zoom(1.25)} aria-label={t('mermaid.zoomIn')} title={t('mermaid.zoomIn')}>
          <ZoomIn size={14} aria-hidden />
        </button>
        <button type="button" className="icon-button" onClick={() => zoom(0.8)} aria-label={t('mermaid.zoomOut')} title={t('mermaid.zoomOut')}>
          <ZoomOut size={14} aria-hidden />
        </button>
        <button type="button" className="icon-button" onClick={() => setView({ scale: 1, x: 0, y: 0 })} aria-label={t('mermaid.reset')} title={t('mermaid.reset')}>
          <Maximize size={14} aria-hidden />
        </button>
        {state.kind === 'ok' && (
          <button
            type="button"
            className="icon-button"
            onClick={() => void platform.saveAs('diagram.svg', new TextEncoder().encode(state.svg), 'image/svg+xml')}
            aria-label={t('mermaid.exportSvg')}
            title={t('mermaid.exportSvg')}
          >
            <Download size={14} aria-hidden />
          </button>
        )}
      </div>
      <div
        className="mermaid-viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            zoom(e.deltaY < 0 ? 1.1 : 0.9);
          }
        }}
      >
        {state.kind === 'loading' ? (
          <span className="muted">{t('mermaid.rendering')}</span>
        ) : (
          <div
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: 'center top' }}
            // SVG produced by Mermaid in strict mode (DOMPurify-sanitized), never by the document directly.
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        )}
      </div>
    </figure>
  );
}
