export { MemoryBackend, type Backend, type StoreName, type Tx } from './backend.ts';
export { IndexedDbBackend } from './idb.ts';
export { NativeBackend, type NativeCall, type LegacySnapshot } from './native.ts';
export { adoptLegacyLibrary, migrateLegacy } from './migration.ts';
export { Library, type CreateDocumentInput, type LibraryListener, type LibraryOptions, type MetaPatch, type SyncBase } from './library.ts';
export { SearchIndex, tokenize, type SearchHit } from './search.ts';
export type { HistoryRetention } from './retention.ts';
