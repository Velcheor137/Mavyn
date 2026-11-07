/**
 * Minimal transactional key-value contract implemented by IndexedDB (web) and memory (tests,
 * private browsing fallback). The library logic in `library.ts` is written once against it.
 *
 * Inside `transaction()` callbacks only `tx` operations may be awaited — awaiting anything else
 * (e.g. crypto) would auto-commit an IndexedDB transaction.
 */
export type StoreName = 'documents' | 'contents' | 'revisions' | 'folders' | 'handles' | 'settings' | 'syncBases';

export const STORE_KEYS: Record<StoreName, string> = {
  documents: 'id',
  contents: 'hash',
  revisions: 'id',
  folders: 'id',
  handles: 'documentId',
  settings: 'key',
  syncBases: 'documentId',
};

export interface Tx {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put<T>(store: StoreName, value: T): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  getAll<T>(store: StoreName): Promise<T[]>;
  /** Revisions by `documentId`. */
  revisionsOf<T>(documentId: string): Promise<T[]>;
}

export interface Backend {
  transaction<R>(stores: StoreName[], mode: 'readonly' | 'readwrite', fn: (tx: Tx) => Promise<R>): Promise<R>;
  close(): void;
}

export class MemoryBackend implements Backend {
  private readonly data = new Map<StoreName, Map<string, unknown>>();
  private queue: Promise<unknown> = Promise.resolve();

  async transaction<R>(_stores: StoreName[], mode: 'readonly' | 'readwrite', fn: (tx: Tx) => Promise<R>): Promise<R> {
    // Serialise all transactions; on failure roll back writes like IndexedDB aborts would.
    const run = this.queue.then(async () => {
      const snapshot = mode === 'readwrite' ? this.snapshot() : null;
      try {
        return await fn(this.tx());
      } catch (error) {
        if (snapshot) this.restore(snapshot);
        throw error;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {}

  private table(store: StoreName): Map<string, unknown> {
    let table = this.data.get(store);
    if (!table) {
      table = new Map();
      this.data.set(store, table);
    }
    return table;
  }

  private tx(): Tx {
    return {
      get: async <T>(store: StoreName, key: string) => structuredClone(this.table(store).get(key)) as T | undefined,
      put: async <T>(store: StoreName, value: T) => {
        const key = (value as Record<string, unknown>)[STORE_KEYS[store]];
        if (typeof key !== 'string') throw new Error(`missing key for ${store}`);
        this.table(store).set(key, structuredClone(value));
      },
      delete: async (store: StoreName, key: string) => {
        this.table(store).delete(key);
      },
      getAll: async <T>(store: StoreName) => [...this.table(store).values()].map((v) => structuredClone(v)) as T[],
      revisionsOf: async <T>(documentId: string) =>
        [...this.table('revisions').values()]
          .filter((r) => (r as { documentId: string }).documentId === documentId)
          .map((v) => structuredClone(v)) as T[],
    };
  }

  private snapshot(): Map<StoreName, Map<string, unknown>> {
    return new Map([...this.data].map(([name, table]) => [name, new Map(table)]));
  }

  private restore(snapshot: Map<StoreName, Map<string, unknown>>): void {
    this.data.clear();
    for (const [name, table] of snapshot) this.data.set(name, table);
  }
}
