export { MemoryBackend, type Backend, type StoreName, type Tx } from './backend.ts';
export { IndexedDbBackend } from './idb.ts';
export { Library, type CreateDocumentInput, type LibraryListener, type LibraryOptions, type MetaPatch, type SyncBase } from './library.ts';
export { SearchIndex, tokenize, type SearchHit } from './search.ts';
