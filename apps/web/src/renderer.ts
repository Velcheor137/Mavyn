import { render, type RenderOptions, type RenderResult } from '@mdr/markdown-engine';

/** Documents smaller than this render on the main thread (lower latency than a worker round trip). */
const WORKER_THRESHOLD = 64 * 1024;

type Pending = { resolve(result: RenderResult): void; reject(error: Error): void };

/**
 * Renders large documents in a Web Worker so typing and scrolling stay responsive. Falls back to
 * the main thread when workers are unavailable.
 */
export function createRenderer(): (source: string, options: RenderOptions) => Promise<RenderResult> {
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, Pending>();

  const getWorker = (): Worker | null => {
    if (worker || typeof Worker === 'undefined') return worker;
    try {
      worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ id: number; result?: RenderResult; error?: string }>) => {
        const entry = pending.get(event.data.id);
        if (!entry) return;
        pending.delete(event.data.id);
        if (event.data.result) entry.resolve(event.data.result);
        else entry.reject(new Error(event.data.error ?? 'render failed'));
      };
      worker.onerror = () => {
        for (const entry of pending.values()) entry.reject(new Error('render worker crashed'));
        pending.clear();
        worker?.terminate();
        worker = null;
      };
    } catch {
      worker = null;
    }
    return worker;
  };

  return (source, options) => {
    const w = source.length >= WORKER_THRESHOLD ? getWorker() : null;
    if (!w) {
      try {
        return Promise.resolve(render(source, options));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, source, options });
    });
  };
}
