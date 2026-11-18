import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { AppError, toAppError } from '@mdr/core';
import { STORE_KEYS, type Backend, type StoreName, type Tx } from './backend.ts';

const DB_VERSION = 4;

/**
 * IndexedDB backend. One database per identity (`mdreader:local`, `mdreader:<server>:<user>`) so
 * private data of different accounts never mixes. Schema changes go through `upgrade` with
 * versioned steps — never drop stores holding current user data.
 */
export class IndexedDbBackend implements Backend {
  private constructor(private readonly db: IDBPDatabase) {}

  static async open(name: string): Promise<IndexedDbBackend> {
    try {
      const db = await openDB(name, DB_VERSION, {
        upgrade(database, oldVersion, _newVersion, transaction) {
          if (oldVersion < 1) {
            for (const store of ['documents', 'contents', 'folders', 'handles', 'settings'] as const) {
              database.createObjectStore(store, { keyPath: STORE_KEYS[store] });
            }
          }
          if (oldVersion < 2) {
            // Last-synced server text per document: the common ancestor for three-way merges.
            database.createObjectStore('syncBases', { keyPath: STORE_KEYS.syncBases });
          }
          if (oldVersion < 3) {
            // Bytes of view-only binary documents, by content hash.
            database.createObjectStore('files', { keyPath: STORE_KEYS.files });
          }
          if (oldVersion >= 1 && oldVersion < 4) {
            // Version history is gone (ADR-008): drop old revisions and the texts only they kept.
            const names = database.objectStoreNames as DOMStringList;
            if (names.contains('revisions')) database.deleteObjectStore('revisions' as never);
            void dropUnreferencedContent(transaction as unknown as IDBPTransaction<unknown, StoreName[], 'versionchange'>);
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

/** Deletes `contents` and `files` rows that no document references (runs inside the upgrade). */
async function dropUnreferencedContent(t: IDBPTransaction<unknown, StoreName[], 'versionchange'>): Promise<void> {
  const docs = (await t.objectStore('documents').getAll()) as Array<{ contentHash: string }>;
  const referenced = new Set(docs.map((d) => d.contentHash));
  for (const store of ['contents', 'files'] as const) {
    if (!(t.objectStoreNames as DOMStringList).contains(store)) continue;
    const keys = (await t.objectStore(store).getAllKeys()) as string[];
    for (const key of keys) if (!referenced.has(key)) await t.objectStore(store).delete!(key);
  }
}
