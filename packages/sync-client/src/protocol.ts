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

export interface ChangesResponse {
  documents: DocumentInfo[];
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

export interface ConflictDetails {
  head_revision_id: string;
  content_hash: string;
}

export interface ErrorBody {
  error: { code: string; details: unknown };
}
