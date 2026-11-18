import { AppError, foldKey, type ErrorCode } from '@mdr/core';
import { STORE_KEYS, type Backend, type FileRow, type StoreName, type Tx } from './backend.ts';
import { makeSnippet, tokenize, type SearchHit } from './search.ts';

export type NativeCall = (request: Record<string, unknown>) => Promise<unknown>;
export type LegacySnapshot = Record<StoreName, unknown[]>;

/**
 * Binary channel for the `files` store: bytes travel as raw IPC payloads instead of JSON/base64.
 * `put` sends `bytes`; `get` resolves to the stored bytes, or an empty buffer when absent
 * (supported files are never empty).
 */
export type NativeFileCall = (request: { op: 'putFile' | 'getFile'; token: string; hash: string }, bytes?: Uint8Array) => Promise<ArrayBuffer | Uint8Array | null>;

/** Platform-neutral IPC adapter; Tauri is injected only by the native app entry point. */
export class NativeBackend implements Backend {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly invoke: NativeCall, private readonly onClose?: () => void, private readonly fileCall?: NativeFileCall) {}

  private async callFile(request: Parameters<NativeFileCall>[0], bytes?: Uint8Array): Promise<Uint8Array> {
    if (!this.fileCall) throw new AppError('storage.failed', { reason: 'no_file_channel' });
    try {
      const result = await this.fileCall(request, bytes);
      return result instanceof Uint8Array ? result : new Uint8Array(result ?? new ArrayBuffer(0));
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code = (error as { code?: ErrorCode } | null)?.code;
      throw new AppError(code ?? 'storage.failed', {}, error);
    }
  }

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
    const file = (op: 'putFile' | 'getFile', hash: string, bytes?: Uint8Array) => {
      if (!active) return Promise.reject<Uint8Array>(new AppError('storage.failed', { reason: 'transaction_finished' }));
      return this.callFile({ op, token, hash }, bytes);
    };
    const tx: Tx = {
      get: async <T>(store: StoreName, key: string) => {
        if (store !== 'files') return (await request<T | null>('get', { store, key })) ?? undefined;
        const bytes = await file('getFile', key);
        return (bytes.length ? { hash: key, size: bytes.length, bytes } satisfies FileRow : undefined) as T | undefined;
      },
      // For `files` the native side lists `{ hash, size }` only: bytes are never bulk-loaded.
      getAll: <T>(store: StoreName) => request<T[]>('all', { store }),
      put: async <T>(store: StoreName, value: T) => {
        if (store !== 'files') { await request('put', { store, value }); return; }
        const row = value as unknown as FileRow;
        await file('putFile', row.hash, row.bytes);
      },
      delete: async (store, key) => { await request('delete', { store, key }); },
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
        for (const value of snapshot[store] ?? []) await tx.put(store, value);
      }
      await this.call({ op: 'markImported', token });
    }));
  }

  close(): void { this.closed = true; void this.queue.finally(() => this.onClose?.()); }
}
