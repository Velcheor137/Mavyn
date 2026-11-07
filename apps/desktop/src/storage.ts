import { invoke } from '@tauri-apps/api/core';
import { IndexedDbBackend, Library, migrateLegacy, NativeBackend } from '@mdr/storage';

export async function openNativeLibrary(): Promise<Library> {
  const backend = new NativeBackend((request) => invoke('local_store', { request }));
  try {
    await migrateLegacy(() => IndexedDbBackend.open('mdreader:local'), backend);
    return new Library(backend);
  } catch (error) {
    backend.close();
    throw error;
  }
}
