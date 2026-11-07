import type { FileHandleLike, HandleStore } from '@mdr/platform';
import { openDB } from 'idb';

/** File System Access handles are structured-cloneable and persist in their own IndexedDB. */
export async function createHandleStore(): Promise<HandleStore> {
  const db = await openDB('mdreader-handles', 1, {
    upgrade(database) {
      database.createObjectStore('handles');
    },
  });
  return {
    get: async (locator) => (await db.get('handles', locator)) as FileHandleLike | undefined,
    put: async (locator, handle) => {
      await db.put('handles', handle, locator);
    },
  };
}
