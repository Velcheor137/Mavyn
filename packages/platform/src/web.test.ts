import { AppError } from '@mdr/core';
import { describe, expect, it } from 'vitest';
import { WebPlatformAdapter, type FileHandleLike, type HandleStore } from './index.ts';

class FakeHandle implements FileHandleLike {
  writes = 0;
  constructor(public name: string, public content: string, public modified = 1000) {}
  async getFile(): Promise<File> {
    return new File([this.content], this.name, { lastModified: this.modified });
  }
  async createWritable() {
    let next = '';
    return {
      write: async (data: Uint8Array) => {
        next += new TextDecoder().decode(data);
      },
      close: async () => {
        this.content = next;
        this.modified += 1;
        this.writes++;
      },
    };
  }
  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }
  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }
}

function setup(handle: FakeHandle) {
  const stored = new Map<string, FileHandleLike>();
  const store: HandleStore = { get: async (k) => stored.get(k), put: async (k, h) => void stored.set(k, h) };
  const win = Object.assign(Object.create(window) as Window, { showOpenFilePicker: async () => [handle] });
  return new WebPlatformAdapter(store, win);
}

const encode = (s: string) => new TextEncoder().encode(s);

describe('WebPlatformAdapter linked files', () => {
  it('reports link capability only with the File System Access API', () => {
    expect(new WebPlatformAdapter({ get: async () => undefined, put: async () => {} }, window).capabilities.linkFiles).toBe(false);
    expect(setup(new FakeHandle('a.md', 'x')).capabilities.linkFiles).toBe(true);
  });

  it('writes back when unchanged and refuses when changed externally', async () => {
    const handle = new FakeHandle('notes.md', '- [ ] a\n');
    const adapter = setup(handle);
    const [picked] = await adapter.pickFiles({ link: true, multiple: false });
    expect(picked?.locator).toMatch(/^fsa:/);

    const fp2 = await adapter.writeLinked(picked!.locator!, encode('- [x] a\n'), picked!.fingerprint!);
    expect(handle.content).toBe('- [x] a\n');

    handle.content = 'edited in another app';
    handle.modified = 9999;
    await expect(adapter.writeLinked(picked!.locator!, encode('mine'), fp2)).rejects.toMatchObject({ code: 'file.external_change' });
    expect(handle.content).toBe('edited in another app');
  });

  it('refuses same-size external edits even when mtime is unchanged', async () => {
    const handle = new FakeHandle('a.md', 'aaaa');
    const adapter = setup(handle);
    const [picked] = await adapter.pickFiles({ link: true, multiple: false });
    handle.content = 'bbbb';
    await expect(adapter.writeLinked(picked!.locator!, encode('mine'), picked!.fingerprint!)).rejects.toMatchObject({ code: 'file.external_change' });
    expect(handle.content).toBe('bbbb');
    expect(handle.writes).toBe(0);
  });

  it('tolerates mtime-only changes when content is identical', async () => {
    const handle = new FakeHandle('a.md', 'same');
    const adapter = setup(handle);
    const [picked] = await adapter.pickFiles({ link: true, multiple: false });
    handle.modified = 5000; // e.g. `touch` or a sync client
    await adapter.writeLinked(picked!.locator!, encode('new'), picked!.fingerprint!);
    expect(handle.content).toBe('new');
  });

  it('throws file.not_found for unknown locators', async () => {
    const adapter = setup(new FakeHandle('a.md', ''));
    await expect(adapter.readLinked('fsa:missing')).rejects.toBeInstanceOf(AppError);
  });
});
