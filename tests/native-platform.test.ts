import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { TauriPlatformAdapter } from '../apps/desktop/src/tauri-platform.ts';

describe('native platform routing', () => {
  beforeEach(() => invoke.mockReset());

  it('uses native Android capabilities rather than desktop printing/associations', async () => {
    invoke.mockResolvedValueOnce('android');
    const adapter = await TauriPlatformAdapter.create();
    expect(adapter.kind).toBe('android');
    expect(adapter.capabilities).toEqual({ linkFiles: true, fileAssociations: true, print: false });
  });

  it('keeps desktop capabilities', async () => {
    invoke.mockResolvedValueOnce('desktop');
    const adapter = await TauriPlatformAdapter.create();
    expect(adapter.kind).toBe('desktop');
    expect(adapter.capabilities.print).toBe(true);
  });

  it('requests persistent access only for link mode and preserves exact bytes', async () => {
    const fingerprint = { size: 8, modifiedMs: 0, contentHash: 'hash' };
    const picked = { name: 'a.md', locator: 'content://documents/a', bytesBase64: '77u/IyBhDQo=', fingerprint };
    invoke.mockResolvedValueOnce('android').mockResolvedValueOnce([picked]).mockResolvedValueOnce([picked]);
    const adapter = await TauriPlatformAdapter.create();
    const [linked] = await adapter.pickFiles({ link: true, multiple: false });
    expect(invoke).toHaveBeenLastCalledWith('pick_markdown_files', { link: true, multiple: false });
    expect(linked!.locator).toBe(picked.locator);
    expect([...linked!.bytes]).toEqual([239, 187, 191, 35, 32, 97, 13, 10]);
    const [imported] = await adapter.pickFiles({ link: false, multiple: true });
    expect(invoke).toHaveBeenLastCalledWith('pick_markdown_files', { link: false, multiple: true });
    expect(imported!.locator).toBeNull();
    expect(imported!.fingerprint).toBeNull();
  });

  it('passes the expected hash on writes and preserves native permission errors', async () => {
    invoke.mockResolvedValueOnce('android').mockRejectedValueOnce({ code: 'file.permission_denied' });
    const adapter = await TauriPlatformAdapter.create();
    const expected = { size: 1, modifiedMs: 0, contentHash: 'expected' };
    await expect(adapter.writeLinked('content://documents/a', new Uint8Array([120]), expected))
      .rejects.toMatchObject({ code: 'file.permission_denied' });
    expect(invoke).toHaveBeenLastCalledWith('write_linked', { locator: 'content://documents/a', bytesBase64: 'eA==', expected });
  });
});
