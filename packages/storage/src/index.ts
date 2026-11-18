export { MemoryBackend, type Backend, type FileRow, type StoreName, type Tx } from './backend.ts';
export { IndexedDbBackend } from './idb.ts';
export { NativeBackend, type NativeCall, type NativeFileCall, type LegacySnapshot } from './native.ts';
export { adoptLegacyLibrary, migrateLegacy } from './migration.ts';
export { Library, type CreateDocumentInput, type CreateFileInput, type LibraryListener, type LibraryOptions, type MetaPatch, type SyncBase } from './library.ts';
export { SearchIndex, tokenize, type SearchHit } from './search.ts';
