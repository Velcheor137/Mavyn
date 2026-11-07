import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { AppError, toAppError } from '@mdr/core';
import { STORE_KEYS, type Backend, type StoreName, type Tx } from './backend.ts';

const DB_VERSION = 2;

/**
 * IndexedDB backend. One database per identity (`mdreader:local`, `mdreader:<server>:<user>`) so
 * private data of different accounts never mixes. Schema changes go through `upgrade` with
 * versioned steps — never drop stores holding user data.
 */
export class IndexedDbBackend implements Backend {
  private constructor(private readonly db: IDBPDatabase) {}

  static async open(name: string): Promise<IndexedDbBackend> {
    try {
      const db = await openDB(name, DB_VERSION, {
        upgrade(database, oldVersion) {
          if (oldVersion < 1) {
            for (const store of ['documents', 'contents', 'revisions', 'folders', 'handles', 'settings'] as const) {
              const os = database.createObjectStore(store, { keyPath: STORE_KEYS[store] });
              if (store === 'revisions') os.createIndex('documentId', 'documentId');
            }
          }
          if (oldVersion < 2) {
            // Last-synced server text per document: the common ancestor for three-way merges.
            database.createObjectStore('syncBases', { keyPath: STORE_KEYS.syncBases });
          }
        },
        blocking() {
          // Another tab wants to upgrade: close so it is not blocked forever.
          db.close();
        },
      });
      return new IndexedDbBackend(db);
    } catch (error) {
      throw new AppError('storage.failed', { name }, error);
    }
  }

  async transaction<R>(stores: StoreName[], mode: 'readonly' | 'readwrite', fn: (tx: Tx) => Promise<R>): Promise<R> {
    let t: IDBPTransaction<unknown, StoreName[], 'readonly' | 'readwrite'>;
    try {
      t = this.db.transaction(stores, mode);
    } catch (error) {
      throw toAppError(error);
    }
    const done = t.done;
    // Aborting rejects `done`; observe it so an expected abort is not an unhandled rejection.
    done.catch(() => undefined);
    const tx: Tx = {
      get: async <T>(store: StoreName, key: string) => (await t.objectStore(store).get(key)) as T | undefined,
      put: async <T>(store: StoreName, value: T) => {
        await t.objectStore(store).put!(value);
      },
      delete: async (store: StoreName, key: string) => {
        await t.objectStore(store).delete!(key);
      },
      getAll: async <T>(store: StoreName) => (await t.objectStore(store).getAll()) as T[],
      revisionsOf: async <T>(documentId: string) => (await t.objectStore('revisions').index('documentId').getAll(documentId)) as T[],
    };
    try {
      const result = await fn(tx);
      await done;
      return result;
    } catch (error) {
      try {
        t.abort();
      } catch {
        // Already finished or aborted; the original error is what matters.
      }
      throw error instanceof AppError ? error : toAppError(error);
    }
  }

  close(): void {
    this.db.close();
  }
}
