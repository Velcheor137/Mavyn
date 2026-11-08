import type { AuthenticatedUser } from '@mdr/ui';

const KEY = 'mavyn.identity.v1';

interface StoredIdentity extends AuthenticatedUser {
  origin: string;
}

/**
 * The last account that signed in on this device. It only selects which local library opens when
 * the server cannot be reached; it is not a credential (the session cookie is HttpOnly) and the
 * server still authenticates every request.
 */
export function loadIdentity(origin: string): AuthenticatedUser | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<StoredIdentity> | null;
    if (!raw || raw.origin !== origin || typeof raw.id !== 'string' || typeof raw.username !== 'string') return null;
    return { id: raw.id, username: raw.username, is_admin: raw.is_admin === true };
  } catch {
    return null;
  }
}

export function rememberIdentity(origin: string, user: AuthenticatedUser): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ origin, ...user } satisfies StoredIdentity));
  } catch {
    // Without storage the device simply cannot open offline; online use is unaffected.
  }
}

export function forgetIdentity(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}
