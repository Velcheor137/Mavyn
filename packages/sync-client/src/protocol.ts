/** TypeScript mirror of `crates/sync-protocol/src/lib.rs`. Keep both in step. */

export const PROTOCOL_VERSION = 1;

export type Role = 'viewer' | 'editor' | 'admin' | 'owner';

export interface UserInfo {
  id: string;
  username: string;
  is_admin: boolean;
}

export interface MeResponse extends UserInfo {
  csrf_token: string;
}

export interface LibraryInfo {
  id: string;
  name: string;
  role: Role;
}

export interface DocumentInfo {
  id: string;
  library_id: string;
  folder_id: string | null;
  title: string;
  file_name: string;
  head_revision_id: string;
  content_hash: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DocumentWithContent extends DocumentInfo {
  content: string;
}

export interface FolderInfo {
  id: string;
  library_id: string;
  /** null is the library root. */
  parent_id: string | null;
  name: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ChangesResponse {
  documents: DocumentInfo[];
  /** Absent from servers older than folder sync. */
  folders?: FolderInfo[];
  cursor: string;
  has_more: boolean;
}

export interface CreateDocumentRequest {
  id: string;
  file_name: string;
  content: string;
  folder_id?: string | null;
}

export interface UpdateContentRequest {
  base_revision_id: string;
  content: string;
  content_hash: string;
}

/** Field-wise compare-and-swap: a field changes only while the server still has its base value. */
export interface UpdateDocumentMetaRequest {
  base_file_name: string;
  base_folder_id: string | null;
  file_name: string;
  folder_id: string | null;
}

/** A live folder with the same name under the same parent is returned instead (different id). */
export interface CreateFolderRequest {
  id: string;
  parent_id: string | null;
  name: string;
}

export interface UpdateFolderRequest {
  base_name: string;
  base_parent_id: string | null;
  name: string;
  parent_id: string | null;
}

export interface ConflictDetails {
  head_revision_id: string;
  content_hash: string;
}

export interface ErrorBody {
  error: { code: string; details: unknown };
}
