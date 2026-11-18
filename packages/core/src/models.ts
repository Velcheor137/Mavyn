/** Domain models shared by all clients. See docs/architecture.md §4. */

/** True for immutable binary documents (docx, xlsx, ods, pdf). */
export function isFileDocument(meta: { kind?: string }): boolean {
  return meta.kind === 'file';
}

export type Iso8601 = string;

export type LibraryKind = 'local' | 'server';

export interface Library {
  id: string;
  name: string;
  kind: LibraryKind;
  serverId?: string;
  createdAt: Iso8601;
}

export interface Folder {
  id: string;
  libraryId: string;
  parentId: string | null;
  name: string;
  createdAt: Iso8601;
  deletedAt: Iso8601 | null;
  /** Set once the folder exists in a server library (same id there). */
  remote?: FolderRemote | null;
}

/** Last name/location known to be identical on the server; local differences are pending. */
export interface FolderRemote {
  serverId: string;
  libraryId: string;
  baseName: string;
  /** Server parent; null is the library root. */
  baseParentId: string | null;
}

/** Where the authoritative bytes of a document live. */
export type DocumentSource =
  | { kind: 'imported' }
  | { kind: 'linked'; locator: string; fingerprint: FileFingerprint | null };

/** What we last saw on disk for a linked file; compared before every save. */
export interface FileFingerprint {
  size: number;
  modifiedMs: number;
  contentHash: string;
}

/** `text` documents are edited Markdown/plain text; `file` documents are immutable binaries. */
export type DocumentKind = 'text' | 'file';

export interface DocumentMeta {
  id: string;
  /** Absent on documents stored before binary support: they are all `text`. */
  kind?: DocumentKind;
  /** MIME type of a `file` document (see `FILE_TYPES`). */
  mime?: string;
  libraryId: string;
  folderId: string | null;
  title: string;
  fileName: string;
  source: DocumentSource;
  contentHash: string;
  /** Whether the file started with a BOM (of its encoding); written back on save. */
  bom: boolean;
  /** WHATWG encoding of the file on disk (`windows-1251`, …); absent means UTF-8. Text documents only. */
  encoding?: string;
  /**
   * Original bytes of a text file imported in a non-UTF-8 encoding, kept (in the `files` store) until
   * the first edit so "Reopen with encoding" can decode them again if detection guessed wrong.
   */
  importBytesHash?: string;
  /**
   * Binary documents: SHA-256 of the bytes the document was imported with ("original of import",
   * in the `files` store). `contentHash` follows every edit; the original never changes.
   */
  originalHash?: string;
  tags: string[];
  favorite: boolean;
  createdAt: Iso8601;
  updatedAt: Iso8601;
  openedAt: Iso8601 | null;
  deletedAt: Iso8601 | null;
  /** Server copy this document syncs with; absent/null for purely local documents. */
  remote?: RemoteRef | null;
}

/**
 * Sync state of one document. The local text is "pending" whenever `contentHash` differs from
 * `baseHash`, so the outbox is derived from durable state and survives crashes by construction.
 */
export interface RemoteRef {
  /** Connection id (see sync-client), e.g. `https://notes.example.com|<userId>`. */
  serverId: string;
  libraryId: string;
  /** Server head revision the local base corresponds to; null until the first upload. */
  baseRevisionId: string | null;
  baseHash: string | null;
  /** A server version that could not be merged automatically; uploads pause until resolved. */
  conflict: { revisionId: string; hash: string } | null;
  /**
   * File name and server folder (null = library root) last known to be identical on the server.
   * Absent on copies synced before folder sync existed: their server folder was always the root.
   */
  baseFileName?: string;
  baseFolderId?: string | null;
  /** File encoding last known on the server (null = UTF-8); absent on copies synced before. */
  baseEncoding?: string | null;
}

export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'offline' | 'conflict' | 'error';

export type SaveState =
  | { kind: 'saved'; at: Iso8601 }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'error'; code: string };
