import { render } from '@mdr/markdown-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, WORKER_THRESHOLD } from './renderer.ts';

/** Just over the size at which rendering moves to the worker. */
const big = `# Big\n\n${'- [ ] a task in a long list\n'.repeat(Math.ceil(WORKER_THRESHOLD / 28))}`;

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  constructor(private readonly behaviour: 'works' | 'crashes' | 'reports-error') {}
  postMessage(message: { id: number; source: string }): void {
    queueMicrotask(() => {
      if (this.behaviour === 'crashes') this.onerror?.(new Event('error') as ErrorEvent);
      else if (this.behaviour === 'reports-error') this.onmessage?.({ data: { id: message.id, error: 'DOMParser is not defined' } } as MessageEvent);
      else this.onmessage?.({ data: { id: message.id, result: render(message.source) } } as MessageEvent);
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe('createRenderer', { timeout: 30_000 }, () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders small documents without starting a worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const start = vi.fn(() => new FakeWorker('works') as unknown as Worker);
    const result = await createRenderer(start)('# Small\n', {});
    expect(result.toc[0]?.text).toBe('Small');
    expect(start).not.toHaveBeenCalled();
  });

  it('renders large documents in the worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const start = vi.fn(() => new FakeWorker('works') as unknown as Worker);
    const result = await createRenderer(start)(big, {});
    expect(start).toHaveBeenCalledTimes(1);
    expect(result.tasks.length).toBeGreaterThan(1000);
  });

  it.each(['crashes', 'reports-error'] as const)('still opens a large document when the worker %s', async (behaviour) => {
    vi.stubGlobal('Worker', FakeWorker);
    const workers: FakeWorker[] = [];
    const start = vi.fn(() => {
      const worker = new FakeWorker(behaviour);
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const renderMarkdown = createRenderer(start);
    const first = await renderMarkdown(big, {});
    expect(first.tasks.length).toBeGreaterThan(1000);
    const second = await renderMarkdown(`${big}\nmore\n`, {});
    expect(second.tasks.length).toBe(first.tasks.length);
    // A crashed worker is not started again.
    if (behaviour === 'crashes') {
      expect(start).toHaveBeenCalledTimes(1);
      expect(workers[0]?.terminated).toBe(true);
    }
  });

  it('renders on the main thread when a worker cannot be created', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const result = await createRenderer(() => {
      throw new Error('blocked by policy');
    })(big, {});
    expect(result.tasks.length).toBeGreaterThan(1000);
  });
});
