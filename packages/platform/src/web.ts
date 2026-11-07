import { AppError, sha256Hex, toAppError, uuidv7, type FileFingerprint } from '@mdr/core';
import { MARKDOWN_EXTENSIONS, type PickedFile, type PlatformAdapter } from './types.ts';

/** The subset of the File System Access API we rely on (Chromium-based browsers). */
export interface FileHandleLike {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

/** Persists file handles so linked documents survive reloads. */
export interface HandleStore {
  get(locator: string): Promise<FileHandleLike | undefined>;
  put(locator: string, handle: FileHandleLike): Promise<void>;
}

type ShowOpenFilePicker = (options: {
  multiple: boolean;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
  excludeAcceptAllOption?: boolean;
}) => Promise<FileHandleLike[]>;

async function fingerprintOf(file: File, bytes: Uint8Array): Promise<FileFingerprint> {
  return { size: file.size, modifiedMs: file.lastModified, contentHash: await sha256Hex(bytes) };
}

async function ensurePermission(handle: FileHandleLike, mode: 'read' | 'readwrite'): Promise<void> {
  if (!handle.queryPermission || !handle.requestPermission) return;
  if ((await handle.queryPermission({ mode })) === 'granted') return;
  // Requires a user gesture; callers invoke this from click handlers.
  if ((await handle.requestPermission({ mode })) !== 'granted') throw new AppError('file.permission_denied');
}

function pickWithInput(multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = [...MARKDOWN_EXTENSIONS, 'text/markdown', 'text/plain'].join(',');
    input.addEventListener('change', () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

export class WebPlatformAdapter implements PlatformAdapter {
  readonly kind = 'web' as const;
  readonly capabilities;
  private readonly showOpenFilePicker: ShowOpenFilePicker | undefined;

  constructor(private readonly handles: HandleStore, win: Window = window) {
    this.showOpenFilePicker = (win as unknown as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker?.bind(win);
    this.capabilities = {
      linkFiles: this.showOpenFilePicker !== undefined,
      fileAssociations: false,
      print: typeof win.print === 'function',
    };
  }

  async pickFiles(options: { link: boolean; multiple: boolean }): Promise<PickedFile[]> {
    if (options.link && this.showOpenFilePicker) {
      let handles: FileHandleLike[];
      try {
        handles = await this.showOpenFilePicker({
          multiple: options.multiple,
          types: [{ description: 'Markdown', accept: { 'text/markdown': [...MARKDOWN_EXTENSIONS] } }],
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return [];
        throw toAppError(error);
      }
      return Promise.all(
        handles.map(async (handle) => {
          await ensurePermission(handle, 'readwrite');
          const file = await handle.getFile();
          const bytes = new Uint8Array(await file.arrayBuffer());
          const locator = `fsa:${uuidv7()}`;
          await this.handles.put(locator, handle);
          return { name: file.name, bytes, locator, fingerprint: await fingerprintOf(file, bytes) };
        }),
      );
    }
    const files = await pickWithInput(options.multiple);
    return Promise.all(files.map(async (file) => fileToPicked(file)));
  }

  async readLinked(locator: string): Promise<{ bytes: Uint8Array; fingerprint: FileFingerprint }> {
    const handle = await this.handle(locator);
    await ensurePermission(handle, 'read');
    try {
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { bytes, fingerprint: await fingerprintOf(file, bytes) };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') throw new AppError('file.not_found', { locator }, error);
      throw toAppError(error);
    }
  }

  async writeLinked(locator: string, bytes: Uint8Array, expected: FileFingerprint): Promise<FileFingerprint> {
    const handle = await this.handle(locator);
    await ensurePermission(handle, 'readwrite');
    const current = await handle.getFile();
    // Metadata can be preserved by editors/sync tools; content is always authoritative.
    const currentBytes = new Uint8Array(await current.arrayBuffer());
    if ((await sha256Hex(currentBytes)) !== expected.contentHash) {
      throw new AppError('file.external_change', { locator });
    }
    // Chromium writes to a swap file and atomically replaces the original on close().
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      await writable.abort?.();
      throw toAppError(error);
    }
    const file = await handle.getFile();
    return { size: file.size, modifiedMs: file.lastModified, contentHash: await sha256Hex(bytes) };
  }

  async saveAs(name: string, bytes: Uint8Array, mime: string): Promise<void> {
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  }

  private async handle(locator: string): Promise<FileHandleLike> {
    const handle = await this.handles.get(locator);
    if (!handle) throw new AppError('file.not_found', { locator });
    return handle;
  }
}

export async function fileToPicked(file: File): Promise<PickedFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), locator: null, fingerprint: null };
}
