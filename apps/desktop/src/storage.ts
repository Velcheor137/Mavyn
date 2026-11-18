import { invoke } from '@tauri-apps/api/core';
import { IndexedDbBackend, Library, migrateLegacy, NativeBackend } from '@mdr/storage';
import { ipcBody } from './ipc-bytes.ts';

export async function openNativeLibrary(): Promise<Library> {
  const backend = new NativeBackend(
    (request) => invoke('local_store', { request }),
    undefined,
    // Raw IPC body/response on desktop; Android sends the body as base64 (see ipc-bytes.ts).
    (request, bytes) =>
      invoke<ArrayBuffer>('local_store_file', ipcBody(bytes), {
        headers: { 'x-mavyn-op': request.op, 'x-mavyn-token': request.token, 'x-mavyn-hash': request.hash },
      }),
  );
  try {
    await migrateLegacy(() => IndexedDbBackend.open('mdreader:local'), backend);
    return new Library(backend);
  } catch (error) {
    backend.close();
    throw error;
  }
}
