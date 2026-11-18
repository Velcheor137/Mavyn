import { invoke } from '@tauri-apps/api/core';
import { AppError, type ErrorCode, type FileFingerprint } from '@mdr/core';
import type { PickedFile, PlatformAdapter } from '@mdr/platform';
import { ipcBody, toBase64 } from './ipc-bytes.ts';

/**
 * Desktop hands bytes over as raw IPC payloads (`bytesToken` + `take_transfer`, raw request bodies);
 * Android uses base64 inside JSON; Linux sends raw bodies as base64 too (see ipc-bytes.ts).
 */
interface NativePicked {
  importId?: string;
  name: string;
  bytesBase64?: string;
  bytesToken?: string;
  locator: string;
  fingerprint: FileFingerprint;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

/** Raw bytes behind a desktop transfer token. */
async function takeTransfer(token: string): Promise<Uint8Array> {
  return new Uint8Array(await call<ArrayBuffer>('take_transfer', { token }));
}

/** Calls a desktop command whose body is raw bytes; other arguments go base64-JSON in a header. */
async function callRaw<T>(command: string, args: Record<string, unknown>, bytes: Uint8Array): Promise<T> {
  const header = toBase64(new TextEncoder().encode(JSON.stringify(args)));
  try {
    return await invoke<T>(command, ipcBody(bytes), { headers: { 'x-mavyn-args': header } });
  } catch (error) {
    const code = (error as { code?: ErrorCode } | null)?.code;
    throw new AppError(code ?? 'unknown', { command }, error);
  }
}

async function bytesOf(f: { bytesBase64?: string; bytesToken?: string }): Promise<Uint8Array> {
  if (f.bytesToken) return takeTransfer(f.bytesToken);
  return fromBase64(f.bytesBase64 ?? '');
}

const toPicked = async (f: NativePicked): Promise<PickedFile> => ({ name: f.name, bytes: await bytesOf(f), locator: f.importId ? null : f.locator, fingerprint: f.importId ? null : f.fingerprint, ...(f.importId ? { importId: f.importId } : {}) });

/** Windows/Linux paths and Android SAF share the same byte-preserving command contract. */
export class TauriPlatformAdapter implements PlatformAdapter {
  readonly capabilities;

  constructor(readonly kind: 'desktop' | 'android' = 'desktop') {
    this.capabilities = { linkFiles: true, fileAssociations: true, print: kind === 'desktop' };
  }

  static async create(): Promise<TauriPlatformAdapter> {
    return new TauriPlatformAdapter(await call<'desktop' | 'android'>('platform_kind'));
  }

  async pickFiles(options: { link: boolean; multiple: boolean }): Promise<PickedFile[]> {
    const files = await Promise.all((await call<NativePicked[]>('pick_markdown_files', options)).map(toPicked));
    // Import mode keeps no reference to the original file.
    return options.link ? files : files.map((f) => ({ ...f, locator: null, fingerprint: null }));
  }

  async readLinked(locator: string) {
    const r = await call<{ bytesBase64?: string; bytesToken?: string; fingerprint: FileFingerprint }>('read_linked', { locator });
    return { bytes: await bytesOf(r), fingerprint: r.fingerprint };
  }

  writeLinked(locator: string, bytes: Uint8Array, expected: FileFingerprint): Promise<FileFingerprint> {
    if (this.kind === 'desktop') return callRaw<FileFingerprint>('write_linked', { locator, expected }, bytes);
    return call<FileFingerprint>('write_linked', { locator, bytesBase64: toBase64(bytes), expected });
  }

  async saveAs(name: string, bytes: Uint8Array): Promise<void> {
    if (this.kind === 'desktop') await callRaw<boolean>('save_as', { name }, bytes);
    else await call<boolean>('save_as', { name, bytesBase64: toBase64(bytes) });
  }

  async takeLaunchFiles(): Promise<PickedFile[]> {
    return Promise.all((await call<NativePicked[]>('take_launch_files')).map(toPicked));
  }

  async acknowledgeIncoming(id: string): Promise<void> {
    if (this.kind === 'android') await call<boolean>('ack_incoming', { id });
  }
}
