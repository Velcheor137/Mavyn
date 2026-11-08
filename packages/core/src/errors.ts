/**
 * Stable, machine-readable error codes. UI code maps them to localized messages via
 * `errors:<code>` keys in packages/i18n; never show `message` to users directly.
 */
export type ErrorCode =
  | 'edit.invalid_range'
  | 'edit.stale_revision'
  | 'edit.marker_mismatch'
  | 'file.not_utf8'
  | 'file.external_change'
  | 'file.permission_denied'
  | 'file.not_found'
  | 'file.unsupported'
  | 'file.write_unsupported'
  | 'storage.quota_exceeded'
  | 'storage.failed'
  | 'storage.busy'
  | 'storage.schema_unsupported'
  | 'storage.migration_conflict'
  | 'document.not_found'
  | 'folder.not_found'
  | 'folder.invalid_name'
  | 'folder.duplicate_name'
  | 'folder.cycle'
  | 'sync.conflict'
  | 'sync.offline'
  | 'sync.protocol_unsupported'
  | 'auth.required'
  | 'auth.invalid_credentials'
  | 'auth.forbidden'
  | 'auth.csrf_failed'
  | 'request.rate_limited'
  | 'library.not_found'
  | 'server.unavailable'
  | 'server.invalid_url'
  | 'setup.invalid_token'
  | 'setup.already_completed'
  | 'user.weak_password'
  | 'user.invalid_username'
  | 'user.username_taken'
  | 'network.failed'
  | 'unknown';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, details: Record<string, unknown> = {}, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new AppError('storage.quota_exceeded', {}, error);
  }
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return new AppError('file.permission_denied', {}, error);
  }
  return new AppError('unknown', {}, error);
}
