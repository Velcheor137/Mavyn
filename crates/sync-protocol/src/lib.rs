//! Wire types of the REST/sync API (`/api/v1`). Mirrored in TypeScript by
//! `packages/sync-client/src/protocol.ts`; JSON fixtures in `tests/fixtures/protocol` keep both in step.

use mdr_domain::Role;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

/// Sent by clients in the `X-Sync-Protocol` header.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: ErrorPayload,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorPayload {
    pub code: String,
    #[serde(default)]
    pub details: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct SetupRequest {
    pub token: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub device_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginResponse {
    /// Bearer token for native clients. Browsers receive it as an HttpOnly cookie instead and
    /// should ignore this field.
    pub token: String,
    pub csrf_token: String,
    pub user: UserInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: Uuid,
    pub username: String,
    pub is_admin: bool,
}

/// `GET /auth/me`. Browsers read their CSRF token here (same-origin only; no CORS), so it never
/// needs to be stored in web storage.
#[derive(Debug, Serialize, Deserialize)]
pub struct MeResponse {
    #[serde(flatten)]
    pub user: UserInfo,
    pub csrf_token: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: Uuid,
    pub device_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub last_seen_at: OffsetDateTime,
    pub current: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateLibraryRequest {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LibraryInfo {
    pub id: Uuid,
    pub name: String,
    pub role: Role,
}

#[derive(Debug, Deserialize)]
pub struct AddMemberRequest {
    pub username: String,
    pub role: Role,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MemberInfo {
    pub user_id: Uuid,
    pub username: String,
    pub role: Role,
}

#[derive(Debug, Deserialize)]
pub struct CreateDocumentRequest {
    /// Client-generated UUIDv7 so documents created offline keep their identity.
    pub id: Uuid,
    pub file_name: String,
    pub content: String,
    #[serde(default)]
    pub folder_id: Option<Uuid>,
}

/// Compare-and-swap content update. Rejected with `sync.conflict` unless `base_revision_id` is
/// the current head.
#[derive(Debug, Deserialize)]
pub struct UpdateContentRequest {
    pub base_revision_id: Uuid,
    pub content: String,
    /// sha-256 hex of the UTF-8 content, verified by the server.
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentInfo {
    pub id: Uuid,
    pub library_id: Uuid,
    pub folder_id: Option<Uuid>,
    pub title: String,
    pub file_name: String,
    pub head_revision_id: Uuid,
    pub content_hash: String,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<OffsetDateTime>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DocumentWithContent {
    #[serde(flatten)]
    pub document: DocumentInfo,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConflictDetails {
    pub head_revision_id: Uuid,
    pub content_hash: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RevisionInfo {
    pub id: Uuid,
    pub parent_revision_id: Option<Uuid>,
    pub content_hash: String,
    pub author: Option<String>,
    pub reason: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// Field-wise compare-and-swap of a document's name and location. A field is changed only when the
/// server still has its `base_*` value; otherwise the server value stays (the response shows it).
#[derive(Debug, Deserialize)]
pub struct UpdateDocumentMetaRequest {
    pub base_file_name: String,
    pub base_folder_id: Option<Uuid>,
    pub file_name: String,
    pub folder_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderInfo {
    pub id: Uuid,
    pub library_id: Uuid,
    /// `None` is the library root.
    pub parent_id: Option<Uuid>,
    pub name: String,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<OffsetDateTime>,
}

/// Creates a folder with a client-chosen id. A live folder with the same name under the same parent
/// is returned instead (its id differs), so devices that created it offline end up with one folder.
#[derive(Debug, Deserialize)]
pub struct CreateFolderRequest {
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    pub name: String,
}

/// Field-wise compare-and-swap rename/move, like [`UpdateDocumentMetaRequest`]. Moves into a
/// missing folder or below the folder itself are ignored.
#[derive(Debug, Deserialize)]
pub struct UpdateFolderRequest {
    pub base_name: String,
    pub base_parent_id: Option<Uuid>,
    pub name: String,
    pub parent_id: Option<Uuid>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChangesResponse {
    /// Document upserts and tombstones (`deleted_at` set), ordered by server sequence.
    pub documents: Vec<DocumentInfo>,
    /// Folder upserts and tombstones from the same sequence range.
    #[serde(default)]
    pub folders: Vec<FolderInfo>,
    /// Opaque cursor for the next request.
    pub cursor: String,
    pub has_more: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchHit {
    pub document_id: Uuid,
    pub title: String,
    pub snippet: String,
    pub rank: f32,
}
