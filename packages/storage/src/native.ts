import { AppError, foldKey, type ErrorCode } from '@mdr/core';
import { STORE_KEYS, type Backend, type StoreName, type Tx } from './backend.ts';
import { makeSnippet, tokenize, type SearchHit } from './search.ts';

export type NativeCall = (request: Record<string, unknown>) => Promise<unknown>;
export type LegacySnapshot = Record<StoreName, unknown[]>;

/** Platform-neutral IPC adapter; Tauri is injected only by the native app entry point. */
export class NativeBackend implements Backend {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly invoke: NativeCall, private readonly onClose?: () => void) {}

  private async call<T>(request: Record<string, unknown>): Promise<T> {
    try { return await this.invoke(request) as T; }
    catch (error) {
      if (error instanceof AppError) throw error;
      const code = (error as { code?: ErrorCode } | null)?.code;
      throw new AppError(code ?? 'storage.failed', {}, error);
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      if (this.closed) throw new AppError('storage.failed', { reason: 'closed' });
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  transaction<R>(stores: StoreName[], mode: 'readonly' | 'readwrite', fn: (tx: Tx) => Promise<R>): Promise<R> {
    return this.enqueue(() => this.runTransaction(stores, mode, fn));
  }

  private async runTransaction<R>(stores: StoreName[], mode: 'readonly' | 'readwrite', fn: (tx: Tx, token: string) => Promise<R>): Promise<R> {
    const token = await this.call<string>({ op: 'begin', stores, mode });
    let active = true;
    const request = <T>(op: string, args: Record<string, unknown>) => {
      if (!active) return Promise.reject<T>(new AppError('storage.failed', { reason: 'transaction_finished' }));
      return this.call<T>({ op, token, ...args });
    };
    const tx: Tx = {
      get: async <T>(store: StoreName, key: string) => (await request<T | null>('get', { store, key })) ?? undefined,
      getAll: <T>(store: StoreName) => request<T[]>('all', { store }),
      put: async <T>(store: StoreName, value: T) => { await request('put', { store, value }); },
      delete: async (store, key) => { await request('delete', { store, key }); },
      revisionsOf: <T>(documentId: string) => request<T[]>('revisions', { documentId }),
    };
    try {
      const result = await fn(tx, token);
      await this.call({ op: 'commit', token });
      return result;
    } catch (error) {
      try { await this.call({ op: 'rollback', token }); }
      catch { /* An expired/disconnected transaction is already rolled back; retain the original error. */ }
      throw error;
    } finally { active = false; }
  }

  search(query: string, limit = 50): Promise<SearchHit[]> {
    return this.enqueue(async () => {
      const terms = tokenize(query);
      if (!terms.length || limit <= 0) return [];
      const rows = await this.call<Array<{ documentId: string; score: number; title: string; text: string }>>({ op: 'search', terms, limit: Math.min(100, Math.floor(limit)) });
      return rows.map((row) => ({ documentId: row.documentId, score: row.score, inTitle: terms.every((term) => foldKey(row.title).includes(term)), ...makeSnippet(row.text, foldKey(row.text), terms) }));
    });
  }

  legacyStatus(): Promise<{ empty: boolean; legacyImported: boolean }> {
    return this.enqueue(() => this.call({ op: 'status' }));
  }

  importLegacy(snapshot: LegacySnapshot): Promise<void> {
    return this.enqueue(() => this.runTransaction(Object.keys(STORE_KEYS) as StoreName[], 'readwrite', async (tx, token) => {
      // Recheck after BEGIN: another window may have imported between status and begin.
      for (const store of Object.keys(STORE_KEYS) as StoreName[]) {
        if ((await tx.getAll(store)).length) throw new AppError('storage.migration_conflict');
      }
      for (const store of Object.keys(STORE_KEYS) as StoreName[]) {
        for (const value of snapshot[store]) await tx.put(store, value);
      }
      await this.call({ op: 'markImported', token });
    }));
  }

  close(): void { this.closed = true; void this.queue.finally(() => this.onClose?.()); }
}
