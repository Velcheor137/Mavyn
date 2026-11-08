import { AppError } from '@mdr/core';
import { STORE_KEYS, type Backend, type StoreName } from './backend.ts';
import type { LegacySnapshot, NativeBackend } from './native.ts';

function assertJson(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(assertJson); return; }
  if (typeof value === 'object' && value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    for (const entry of Object.values(value)) {
      // Optional fields disappear under JSON serialization, as in native domain records.
      if (entry !== undefined) assertJson(entry);
    }
    return;
  }
  throw new AppError('storage.failed', { reason: 'non_json_legacy_record' });
}

/** Source is a consistent readonly snapshot, retained untouched after native commit. */
export async function migrateLegacy(openSource: () => Promise<Backend>, target: NativeBackend): Promise<void> {
  const status = await target.legacyStatus();
  if (status.legacyImported) return;
  if (!status.empty) throw new AppError('storage.migration_conflict');
  const source = await openSource();
  try {
    const stores = Object.keys(STORE_KEYS) as StoreName[];
    const snapshot = await source.transaction(stores, 'readonly', async (tx) => {
      const result = {} as LegacySnapshot;
      for (const store of stores) result[store] = await tx.getAll(store);
      return result;
    });
    assertJson(snapshot);
    await target.importLegacy(snapshot);
  } finally { source.close(); }
}

/**
 * Moves the anonymous browser library (pre-authentication web builds) into the signed-in user's
 * database. Runs only into an empty target, so it happens once; the caller deletes the source
 * afterwards so a second account on the same browser cannot adopt it again.
 * Returns whether anything was copied.
 */
export async function adoptLegacyLibrary(source: Backend, target: Backend): Promise<boolean> {
  const stores = Object.keys(STORE_KEYS) as StoreName[];
  const targetEmpty = await target.transaction(['documents', 'folders'], 'readonly', async (tx) =>
    (await tx.getAll('documents')).length === 0 && (await tx.getAll('folders')).length === 0);
  if (!targetEmpty) return false;
  const snapshot = await source.transaction(stores, 'readonly', async (tx) => {
    const result = new Map<StoreName, unknown[]>();
    for (const store of stores) result.set(store, await tx.getAll(store));
    return result;
  });
  if ((snapshot.get('documents')?.length ?? 0) === 0 && (snapshot.get('folders')?.length ?? 0) === 0) return false;
  await target.transaction(stores, 'readwrite', async (tx) => {
    for (const [store, rows] of snapshot) for (const row of rows) await tx.put(store, row);
  });
  return true;
}
