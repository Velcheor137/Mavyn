import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { nativeFetch } from '../apps/desktop/src/native-sync.ts';

describe('native sync bridge', () => {
  beforeEach(() => invoke.mockReset());
  it('routes HTTP through restricted native requests without exposing auth headers or cookies', async () => {
    invoke.mockResolvedValueOnce({ status: 200, body: { id: 'user', csrf_token: 'csrf' } });
    const response = await nativeFetch('https://notes.example')('https://notes.example/api/v1/auth/me', { method: 'GET', headers: { 'x-sync-protocol': '1' } });
    expect(await response.json()).toEqual({ id: 'user', csrf_token: 'csrf' });
    expect(invoke).toHaveBeenCalledWith('native_sync_request', { baseUrl: 'https://notes.example', request: { method: 'GET', path: '/api/v1/auth/me', body: null, opId: null } });
  });
  it('refuses requests to another origin before calling native code', async () => {
    await expect(nativeFetch('https://notes.example')('https://other.example/api/v1/auth/me')).rejects.toMatchObject({ code: 'network.failed' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
