/**
 * Body of a binary IPC command. Windows (and macOS) webviews send raw bytes. Android and Linux
 * cannot: Tauri's IPC goes through `postMessage` there (Android has no request bodies, WebKitGTK
 * custom protocols get them only with wry's `linux-body`), which carries JSON only. There the
 * bytes travel as base64 inside JSON and the native side decodes them (`body_bytes` in
 * src-tauri/src/lib.rs).
 */
export const rawIpcBodies = !/\b(Android|Linux)\b/i.test(globalThis.navigator?.userAgent ?? '');

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function ipcBody(bytes: Uint8Array | undefined): Uint8Array | Record<string, string> {
  if (!bytes) return {};
  return rawIpcBodies ? bytes : { bytesBase64: toBase64(bytes) };
}
