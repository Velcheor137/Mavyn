import { invoke } from '@tauri-apps/api/core';
import { AppError, type ErrorCode } from '@mdr/core';
import { HttpSyncApi } from '@mdr/sync-client';
import type { Library } from '@mdr/storage';
import type { AppServices } from '@mdr/ui';
import { ipcBody } from './ipc-bytes.ts';

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(command, args); }
  catch (error) { throw new AppError((error as { code?: ErrorCode } | null)?.code ?? 'network.failed', {}, error); }
}

/** Binary documents: upload, replace (`PUT …/file`), download and original (raw bytes, no JSON). */
const FILE_ROUTE = /^\/api\/v1\/(libraries\/[^/]+\/files|documents\/[^/]+\/(file|original))$/;

async function binaryFetch(baseUrl: string, url: URL, init: RequestInit | undefined, headers: Headers): Promise<Response> {
  const body = init?.body;
  if (body !== undefined && body !== null && !(body instanceof Uint8Array)) throw new AppError('network.failed');
  let framed: ArrayBuffer;
  try {
    framed = await invoke<ArrayBuffer>('native_sync_file', ipcBody(body ?? undefined), {
      headers: {
        'x-mavyn-base': baseUrl,
        'x-mavyn-method': init?.method ?? 'GET',
        'x-mavyn-path': url.pathname + url.search,
        ...(headers.get('idempotency-key') ? { 'idempotency-key': headers.get('idempotency-key')! } : {}),
      },
    });
  } catch (error) {
    throw new AppError((error as { code?: ErrorCode } | null)?.code ?? 'network.failed', {}, error);
  }
  // Framing: big-endian u16 HTTP status, then the response body.
  const view = new DataView(framed);
  const status = view.getUint16(0);
  return new Response(status === 204 ? null : framed.slice(2), { status });
}

/** Reuse the shared protocol client; only the native process sees its bearer credential. */
export function nativeFetch(baseUrl: string): typeof fetch {
  return async (input, init) => {
    if (typeof input !== 'string' && !(input instanceof URL)) throw new AppError('network.failed');
    const url = new URL(input);
    if (url.origin !== new URL(baseUrl).origin || url.username || url.password || url.hash) throw new AppError('network.failed');
    const headers = new Headers(init?.headers);
    if (FILE_ROUTE.test(url.pathname)) return binaryFetch(baseUrl, url, init, headers);
    if (init?.body !== undefined && typeof init.body !== 'string') throw new AppError('network.failed');
    const response = await call<{ status: number; body: unknown }>('native_sync_request', {
      baseUrl,
      request: {
        method: init?.method ?? 'GET',
        path: url.pathname + url.search,
        body: init?.body ? JSON.parse(init.body) as unknown : null,
        opId: headers.get('idempotency-key'),
      },
    });
    return new Response(response.status === 204 ? null : JSON.stringify(response.body), {
      status: response.status, headers: { 'content-type': 'application/json' },
    });
  };
}

const URL_SETTING = 'native.serverUrl';
export async function createNativeSync(library: Library): Promise<Pick<AppServices, 'server' | 'configureServer'>> {
  if (!await call<boolean>('native_sync_supported')) return {};
  const configureServer = async (input: string): Promise<AppServices['server']> => {
    if (!input.trim()) {
      await library.putSetting(URL_SETTING, null);
      return undefined;
    }
    const baseUrl = await call<string>('native_sync_url', { url: input });
    const api = new HttpSyncApi(baseUrl, nativeFetch(baseUrl));
    await library.putSetting(URL_SETTING, baseUrl);
    return { baseUrl, api, health: () => api.health() };
  };
  const saved = await library.getSetting<string>(URL_SETTING);
  const server = saved ? await configureServer(saved) : undefined;
  return { configureServer, ...(server ? { server } : {}) };
}
