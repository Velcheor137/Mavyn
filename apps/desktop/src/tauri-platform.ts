import { invoke } from '@tauri-apps/api/core';
import { AppError, type ErrorCode, type FileFingerprint } from '@mdr/core';
import type { PickedFile, PlatformAdapter } from '@mdr/platform';

interface NativePicked {
  name: string;
  bytesBase64: string;
  locator: string;
  fingerprint: FileFingerprint;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Native commands reject with `{ code }` (see src-tauri/src/lib.rs). */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const code = (error as { code?: ErrorCode } | null)?.code;
    throw new AppError(code ?? 'unknown', { command }, error);
  }
}

const toPicked = (f: NativePicked): PickedFile => ({ name: f.name, bytes: fromBase64(f.bytesBase64), locator: f.locator, fingerprint: f.fingerprint });

/** Windows/Linux: real files, edited in place with atomic writes. Android SAF: not yet implemented. */
export class TauriPlatformAdapter implements PlatformAdapter {
  readonly kind = 'desktop' as const;
  readonly capabilities = { linkFiles: true, fileAssociations: true, print: true };

  async pickFiles(options: { link: boolean; multiple: boolean }): Promise<PickedFile[]> {
    const files = (await call<NativePicked[]>('pick_markdown_files', { multiple: options.multiple })).map(toPicked);
    // Import mode keeps no reference to the original file.
    return options.link ? files : files.map((f) => ({ ...f, locator: null, fingerprint: null }));
  }

  async readLinked(locator: string) {
    const r = await call<{ bytesBase64: string; fingerprint: FileFingerprint }>('read_linked', { locator });
    return { bytes: fromBase64(r.bytesBase64), fingerprint: r.fingerprint };
  }

  writeLinked(locator: string, bytes: Uint8Array, expected: FileFingerprint): Promise<FileFingerprint> {
    return call<FileFingerprint>('write_linked', { locator, bytesBase64: toBase64(bytes), expected });
  }

  async saveAs(name: string, bytes: Uint8Array): Promise<void> {
    await call<boolean>('save_as', { name, bytesBase64: toBase64(bytes) });
  }

  async takeLaunchFiles(): Promise<PickedFile[]> {
    return (await call<NativePicked[]>('take_launch_files')).map(toPicked);
  }
}
