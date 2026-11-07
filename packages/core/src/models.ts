/** Domain models shared by all clients. See docs/architecture.md §4. */

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

export interface DocumentMeta {
  id: string;
  libraryId: string;
  folderId: string | null;
  title: string;
  fileName: string;
  source: DocumentSource;
  headRevisionId: string;
  contentHash: string;
  /** Whether the stored file started with a UTF-8 BOM; written back on save. */
  bom: boolean;
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
}

export type RevisionReason = 'import' | 'edit' | 'restore' | 'merge' | 'conflict' | 'sync';

export interface Revision {
  id: string;
  documentId: string;
  parentRevisionId: string | null;
  contentHash: string;
  size: number;
  authorId: string | null;
  reason: RevisionReason;
  createdAt: Iso8601;
}

export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'offline' | 'conflict' | 'error';

export type SaveState =
  | { kind: 'saved'; at: Iso8601 }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'error'; code: string };
