import { AppError, type ErrorCode } from '@mdr/core';
import {
  PROTOCOL_VERSION,
  type ChangesResponse,
  type CreateDocumentRequest,
  type DocumentInfo,
  type DocumentWithContent,
  type ErrorBody,
  type LibraryInfo,
  type MeResponse,
  type UpdateContentRequest,
  type UserInfo,
} from './protocol.ts';

/** Server operations the sync engine needs. Implemented over HTTP and by the test fake. */
export interface SyncApi {
  /** True while the server has no users and waits for the first administrator. */
  needsSetup(): Promise<boolean>;
  /** Creates the first administrator with the one-time token from the server log. */
  setup(token: string, username: string, password: string): Promise<UserInfo>;
  me(): Promise<MeResponse>;
  login(username: string, password: string): Promise<MeResponse>;
  logout(): Promise<void>;
  listLibraries(): Promise<LibraryInfo[]>;
  createLibrary(name: string): Promise<LibraryInfo>;
  changes(libraryId: string, cursor: string): Promise<ChangesResponse>;
  getDocument(id: string): Promise<DocumentWithContent>;
  createDocument(libraryId: string, request: CreateDocumentRequest, opId: string): Promise<DocumentInfo>;
  /** Rejects with `SyncHttpError` code `sync.conflict` (details: ConflictDetails) when the base is stale. */
  updateContent(id: string, request: UpdateContentRequest, opId: string): Promise<DocumentInfo>;
  deleteDocument(id: string): Promise<void>;
}

/** Error returned by the server: HTTP status plus its stable code. */
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: unknown,
  ) {
    super(code);
    this.name = 'SyncHttpError';
  }
}

/** Server codes that also exist as client error codes (and therefore have translations). */
const KNOWN: ReadonlySet<string> = new Set<ErrorCode>([
  'auth.required',
  'auth.invalid_credentials',
  'auth.forbidden',
  'auth.csrf_failed',
  'request.rate_limited',
  'library.not_found',
  'document.not_found',
  'sync.conflict',
  'sync.protocol_unsupported',
  'setup.invalid_token',
  'setup.already_completed',
  'user.weak_password',
  'user.invalid_username',
  'user.username_taken',
]);

/** Maps transport and server failures to client error codes. */
export function toSyncAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof SyncHttpError) {
    const code = (KNOWN.has(error.code) ? error.code : error.status >= 500 ? 'server.unavailable' : 'unknown') as ErrorCode;
    return new AppError(code, { status: error.status }, error);
  }
  // fetch rejects with TypeError when the network or server is unreachable.
  return new AppError('sync.offline', {}, error);
}

/**
 * Same-origin HTTP client for the web app: authenticates with the HttpOnly session cookie and
 * sends the session's CSRF token (read from `/auth/me`, never persisted) on unsafe requests.
 */
export class HttpSyncApi implements SyncApi {
  private csrf: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, opId?: string): Promise<T> {
    const headers: Record<string, string> = { 'x-sync-protocol': String(PROTOCOL_VERSION) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && this.csrf) headers['x-csrf-token'] = this.csrf;
    if (opId) headers['idempotency-key'] = opId;
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return undefined as T;
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // Non-JSON responses (proxy errors, HTML pages) are handled by the status check below.
    }
    if (!response.ok) {
      const error = (parsed as ErrorBody | null)?.error;
      throw new SyncHttpError(response.status, error?.code ?? `http.${response.status}`, error?.details ?? null);
    }
    return parsed as T;
  }

  async health(): Promise<boolean> {
    try {
      const r = await this.fetchImpl(`${this.baseUrl}/api/v1/health`, { cache: 'no-store' });
      return r.ok && ((await r.json()) as { status?: string }).status === 'ok';
    } catch {
      return false;
    }
  }

  async needsSetup(): Promise<boolean> {
    return (await this.request<{ needs_setup: boolean }>('GET', '/setup')).needs_setup;
  }

  setup(token: string, username: string, password: string): Promise<UserInfo> {
    return this.request('POST', '/setup', { token: token.trim(), username, password });
  }

  async me(): Promise<MeResponse> {
    const me = await this.request<MeResponse>('GET', '/auth/me');
    this.csrf = me.csrf_token;
    return me;
  }

  async login(username: string, password: string): Promise<MeResponse> {
    await this.request('POST', '/auth/login', { username, password, device_name: navigatorName() });
    return this.me();
  }

  async logout(): Promise<void> {
    await this.request('POST', '/auth/logout');
    this.csrf = null;
  }

  listLibraries(): Promise<LibraryInfo[]> {
    return this.request('GET', '/libraries');
  }

  createLibrary(name: string): Promise<LibraryInfo> {
    return this.request('POST', '/libraries', { name });
  }

  changes(libraryId: string, cursor: string): Promise<ChangesResponse> {
    return this.request('GET', `/libraries/${encodeURIComponent(libraryId)}/changes?cursor=${encodeURIComponent(cursor)}`);
  }

  getDocument(id: string): Promise<DocumentWithContent> {
    return this.request('GET', `/documents/${encodeURIComponent(id)}`);
  }

  createDocument(libraryId: string, request: CreateDocumentRequest, opId: string): Promise<DocumentInfo> {
    return this.request('POST', `/libraries/${encodeURIComponent(libraryId)}/documents`, request, opId);
  }

  updateContent(id: string, request: UpdateContentRequest, opId: string): Promise<DocumentInfo> {
    return this.request('PUT', `/documents/${encodeURIComponent(id)}/content`, request, opId);
  }

  deleteDocument(id: string): Promise<void> {
    return this.request('DELETE', `/documents/${encodeURIComponent(id)}`);
  }
}

function navigatorName(): string | undefined {
  const ua = globalThis.navigator?.userAgent;
  if (!ua) return undefined;
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ');
}
