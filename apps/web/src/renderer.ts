import { render, type RenderOptions, type RenderResult } from '@mdr/markdown-engine';

/** Documents smaller than this render on the main thread (lower latency than a worker round trip). */
export const WORKER_THRESHOLD = 64 * 1024;

type Pending = { source: string; options: RenderOptions; resolve(result: RenderResult): void; reject(error: Error): void };
type WorkerReply = { id: number; result?: RenderResult; error?: string };

const startWorker = (): Worker => new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });

function renderHere(source: string, options: RenderOptions): Promise<RenderResult> {
  try {
    return Promise.resolve(render(source, options));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Renders large documents in a Web Worker so typing and scrolling stay responsive. A worker that
 * cannot start, crashes or fails a request is never a dead end: the document renders on the main
 * thread instead (slower, but it opens), and a crashed worker is not started again.
 */
export function createRenderer(createWorker: () => Worker = startWorker): (source: string, options: RenderOptions) => Promise<RenderResult> {
  let worker: Worker | null = null;
  let broken = typeof Worker === 'undefined';
  let seq = 0;
  const pending = new Map<number, Pending>();

  const fallBack = (id: number): void => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    renderHere(entry.source, entry.options).then(entry.resolve, entry.reject);
  };

  const giveUpOnWorker = (): void => {
    broken = true;
    worker?.terminate();
    worker = null;
    for (const id of [...pending.keys()]) fallBack(id);
  };

  const getWorker = (): Worker | null => {
    if (worker || broken) return worker;
    try {
      worker = createWorker();
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        const entry = pending.get(event.data.id);
        if (!entry) return;
        if (!event.data.result) return fallBack(event.data.id);
        pending.delete(event.data.id);
        entry.resolve(event.data.result);
      };
      worker.onerror = giveUpOnWorker;
      worker.onmessageerror = giveUpOnWorker;
    } catch {
      giveUpOnWorker();
    }
    return worker;
  };

  return (source, options) => {
    const w = source.length >= WORKER_THRESHOLD ? getWorker() : null;
    if (!w) return renderHere(source, options);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { source, options, resolve, reject });
      try {
        w.postMessage({ id, source, options });
      } catch {
        fallBack(id);
      }
    });
  };
}
