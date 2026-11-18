use crate::auth::{require_document_role, require_role, AuthUser};
use crate::crypto;
use crate::error::{file_codes, ApiError, ApiResult};
use crate::routes::folders::{is_live_folder, lock_library, FolderRow, FOLDER_COLUMNS};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{FromRequest, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use mdr_domain::{codes, Role};
use mdr_sync_protocol::{
    ConflictDetails, CreateDocumentRequest, DocumentInfo, FolderInfo, SearchHit,
    UpdateContentRequest, UpdateDocumentMetaRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use time::OffsetDateTime;
use uuid::Uuid;

const DOC_COLUMNS: &str = "id, library_id, folder_id, title, file_name, head_revision_id, content_hash, updated_at, deleted_at, kind, mime, encoding, original_hash";

/// `documents.kind` of Markdown/plain-text documents.
const KIND_TEXT: &str = "text";
/// `documents.kind` of binary documents (docx/xlsx/ods/pdf).
const KIND_FILE: &str = "file";

/// MIME types accepted by `POST /libraries/{id}/files`, with the signature their bytes must start
/// with (docx/xlsx/ods are zip containers).
const FILE_TYPES: &[(&str, &[u8])] = &[
    (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        b"PK\x03\x04",
    ),
    (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        b"PK\x03\x04",
    ),
    (
        "application/vnd.oasis.opendocument.spreadsheet",
        b"PK\x03\x04",
    ),
    ("application/pdf", b"%PDF-"),
];

#[derive(sqlx::FromRow)]
struct DocRow {
    id: Uuid,
    library_id: Uuid,
    folder_id: Option<Uuid>,
    title: String,
    file_name: String,
    head_revision_id: Uuid,
    content_hash: String,
    updated_at: OffsetDateTime,
    deleted_at: Option<OffsetDateTime>,
    kind: String,
    mime: Option<String>,
    encoding: Option<String>,
    original_hash: Option<String>,
}

/// Wire form of a document: [`DocumentInfo`] plus `kind` (`"text"` | `"file"`) and `mime` (null for
/// text), always present. Kept in the server so `mdr-sync-protocol` stays unchanged; TypeScript
/// mirror: `packages/sync-client/src/protocol.ts`.
#[derive(Debug, Serialize)]
pub struct DocInfo {
    #[serde(flatten)]
    pub info: DocumentInfo,
    pub kind: String,
    pub mime: Option<String>,
    /// File encoding of a text document (`null` = UTF-8).
    pub encoding: Option<String>,
    /// SHA-256 of the bytes a binary document was imported with ("original of import"); null for
    /// text. The current bytes (`content_hash`) change with every edit, the original never does.
    pub original_hash: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DocWithContent {
    #[serde(flatten)]
    pub document: DocInfo,
    pub content: String,
}

/// `GET /libraries/{id}/changes`: like `mdr_sync_protocol::ChangesResponse` with [`DocInfo`].
#[derive(Debug, Serialize)]
pub struct DocChangesResponse {
    pub documents: Vec<DocInfo>,
    pub folders: Vec<FolderInfo>,
    pub cursor: String,
    pub has_more: bool,
}

impl From<DocRow> for DocInfo {
    fn from(r: DocRow) -> Self {
        DocInfo {
            info: DocumentInfo {
                id: r.id,
                library_id: r.library_id,
                folder_id: r.folder_id,
                title: r.title,
                file_name: r.file_name,
                head_revision_id: r.head_revision_id,
                content_hash: r.content_hash,
                updated_at: r.updated_at,
                deleted_at: r.deleted_at,
            },
            kind: r.kind,
            mime: r.mime,
            encoding: r.encoding,
            original_hash: r.original_hash,
        }
    }
}

/// Title of a binary document: its file name without the extension.
fn file_title(file_name: &str) -> String {
    file_name
        .rsplit_once('.')
        .map_or(file_name, |(stem, _)| stem)
        .chars()
        .take(300)
        .collect()
}

/// First ATX heading, else the file name without its extension (mirrors `deriveTitle` in core).
pub fn derive_title(content: &str, file_name: &str) -> String {
    // Plain text and code: the whole file name (`#` lines are comments there), like the clients.
    if !is_markdown_name(file_name) {
        return file_name.chars().take(300).collect();
    }
    for line in content.lines().take(200) {
        let trimmed = line.trim_start_matches(' ');
        if line.len() - trimmed.len() > 3 {
            continue;
        }
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) {
            let rest = &trimmed[hashes..];
            if rest.starts_with([' ', '\t']) {
                let title = rest.trim().trim_end_matches('#').trim();
                if !title.is_empty() {
                    return title.chars().take(300).collect();
                }
            }
        }
    }
    file_name
        .rsplit_once('.')
        .map_or(file_name, |(stem, _)| stem)
        .to_owned()
}

/// Markdown file names (mirrors `textFormat` in core); everything else is plain text or code.
fn is_markdown_name(file_name: &str) -> bool {
    let lower = file_name.to_lowercase();
    [".md", ".markdown", ".mdown", ".mkd", ".mdx"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// Validates a WHATWG encoding label; `utf-8` (the default) is stored as NULL.
fn valid_encoding(label: Option<&str>) -> ApiResult<Option<String>> {
    match label.map(str::trim) {
        None | Some("") => Ok(None),
        Some(l) if l.eq_ignore_ascii_case("utf-8") => Ok(None),
        Some(l)
            if l.len() <= 40
                && l.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
        {
            Ok(Some(l.to_ascii_lowercase()))
        }
        Some(_) => Err(ApiError::bad_request("encoding")),
    }
}

fn idempotency_key(headers: &HeaderMap) -> ApiResult<Option<Uuid>> {
    match headers.get("idempotency-key") {
        None => Ok(None),
        Some(v) => v
            .to_str()
            .ok()
            .and_then(|s| Uuid::parse_str(s).ok())
            .map(Some)
            .ok_or_else(|| ApiError::bad_request("Idempotency-Key")),
    }
}

/// Replays the stored response for a retried operation.
async fn replay(
    state: &AppState,
    user: &AuthUser,
    key: Option<Uuid>,
) -> ApiResult<Option<Response>> {
    let Some(key) = key else { return Ok(None) };
    let row: Option<(i16, Value)> = sqlx::query_as(
        "SELECT status, response FROM applied_ops WHERE user_id = $1 AND op_id = $2",
    )
    .bind(user.user_id)
    .bind(key)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(|(status, body)| {
        (
            StatusCode::from_u16(status as u16).unwrap_or(StatusCode::OK),
            Json(body),
        )
            .into_response()
    }))
}

async fn record_op(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: &AuthUser,
    key: Option<Uuid>,
    status: StatusCode,
    body: &Value,
) -> ApiResult<()> {
    if let Some(key) = key {
        sqlx::query(
            "INSERT INTO applied_ops (op_id, user_id, status, response) VALUES ($1, $2, $3, $4)",
        )
        .bind(key)
        .bind(user.user_id)
        .bind(status.as_u16() as i16)
        .bind(body)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

fn valid_file_name(name: &str) -> ApiResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.len() > 255 || name.contains(['/', '\\', '\0']) {
        return Err(ApiError::bad_request("file_name"));
    }
    Ok(name)
}

fn check_size(state: &AppState, content: &str) -> ApiResult<()> {
    if content.len() > state.config.max_document_bytes {
        return Err(
            ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, codes::TOO_LARGE)
                .with_details(json!({ "max_bytes": state.config.max_document_bytes })),
        );
    }
    Ok(())
}

async fn store_blob(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    content: &str,
) -> ApiResult<String> {
    let hash = crypto::sha256_hex(content.as_bytes());
    // `DO UPDATE` (not `DO NOTHING`) locks an existing row until commit, so a concurrent
    // `drop_blob_if_unreferenced` cannot delete content this transaction is about to reference.
    sqlx::query(
        "INSERT INTO blobs (hash, size, content) VALUES ($1, $2, $3) ON CONFLICT (hash) DO UPDATE SET hash = EXCLUDED.hash",
    )
    .bind(&hash)
    .bind(content.len() as i64)
    .bind(content)
    .execute(&mut **tx)
    .await?;
    Ok(hash)
}

/// Deletes a text (`blobs`) or file (`file_blobs`) blob once no document references it: there is no
/// version history (ADR-008). The row lock first, then the check in a new statement (fresh snapshot
/// under READ COMMITTED): a writer that already locked the row via `ON CONFLICT DO UPDATE` and
/// commits a reference is seen, and one that comes later re-inserts the row after this delete.
pub(crate) async fn drop_blob_if_unreferenced(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    table: BlobTable,
    hash: &str,
) -> ApiResult<()> {
    let table = table.name();
    sqlx::query(&format!("SELECT 1 FROM {table} WHERE hash = $1 FOR UPDATE"))
        .bind(hash)
        .execute(&mut **tx)
        .await?;
    sqlx::query(&format!(
        "DELETE FROM {table} WHERE hash = $1 AND NOT EXISTS (SELECT 1 FROM documents WHERE content_hash = $1 OR original_hash = $1)"
    ))
    .bind(hash)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) enum BlobTable {
    Text,
    File,
}

impl BlobTable {
    fn name(self) -> &'static str {
        match self {
            BlobTable::Text => "blobs",
            BlobTable::File => "file_blobs",
        }
    }
}

/// Search vector over title + content; `ё` folded to `е` like the clients do.
/// Only the first 256 KiB of the text are indexed: PostgreSQL caps a tsvector at 1 MiB, and text
/// documents (logs, code) may be up to `MAX_DOCUMENT_BYTES` (256 MiB by default).
const SEARCH_VECTOR: &str =
    "to_tsvector('simple', translate($T || ' ' || left($C, 262144), 'Ёё', 'Ее'))";

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(library_id): Path<Uuid>,
) -> ApiResult<Json<Vec<DocInfo>>> {
    require_role(&state.db, &user, library_id, Role::Viewer).await?;
    let rows: Vec<DocRow> = sqlx::query_as(&format!("SELECT {DOC_COLUMNS} FROM documents WHERE library_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC"))
        .bind(library_id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(library_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<CreateDocumentRequest>,
) -> ApiResult<Response> {
    require_role(&state.db, &user, library_id, Role::Editor).await?;
    let key = idempotency_key(&headers)?;
    if let Some(response) = replay(&state, &user, key).await? {
        return Ok(response);
    }
    check_size(&state, &body.content)?;
    let file_name = valid_file_name(&body.file_name)?;
    let encoding = valid_encoding(body.encoding.as_deref())?;
    let title = derive_title(&body.content, file_name);
    let revision_id = Uuid::now_v7();

    let mut tx = state.db.begin().await?;
    // A folder deleted meanwhile (or never uploaded) leaves the document at the library root.
    let folder_id = match body.folder_id {
        Some(f) if is_live_folder(&mut tx, library_id, f).await? => Some(f),
        _ => None,
    };
    let hash = store_blob(&mut tx, &body.content).await?;
    let sql = format!(
        "INSERT INTO documents (id, library_id, folder_id, title, file_name, head_revision_id, content_hash, encoding, search)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $9, {}) ON CONFLICT (id) DO NOTHING RETURNING {DOC_COLUMNS}",
        SEARCH_VECTOR.replace("$T", "$4").replace("$C", "$8")
    );
    let row: Option<DocRow> = sqlx::query_as(&sql)
        .bind(body.id)
        .bind(library_id)
        .bind(folder_id)
        .bind(&title)
        .bind(file_name)
        .bind(revision_id)
        .bind(&hash)
        .bind(&body.content)
        .bind(&encoding)
        .fetch_optional(&mut *tx)
        .await?;
    // An existing ID (possibly in another library) is a client bug or a probe: never overwrite.
    let row = row.ok_or_else(|| ApiError::new(StatusCode::CONFLICT, codes::CONFLICT))?;
    let info: DocInfo = row.into();
    let response = serde_json::to_value(&info).map_err(|_| ApiError::internal())?;
    record_op(&mut tx, &user, key, StatusCode::CREATED, &response).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(response)).into_response())
}

#[derive(Deserialize)]
pub struct UploadFileQuery {
    /// Client-generated UUIDv7, like `CreateDocumentRequest::id`.
    id: Uuid,
    file_name: String,
    #[serde(default)]
    folder_id: Option<Uuid>,
    /// sha-256 hex of the body.
    sha256: String,
    mime: String,
}

fn too_large_file(state: &AppState) -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, file_codes::TOO_LARGE)
        .with_details(json!({ "max_bytes": state.config.max_file_bytes }))
}

fn signature_for(mime: &str) -> ApiResult<&'static [u8]> {
    FILE_TYPES
        .iter()
        .find(|(m, _)| *m == mime)
        .map(|(_, signature)| *signature)
        .ok_or_else(|| ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, file_codes::UNSUPPORTED))
}

fn valid_sha256(value: &str) -> ApiResult<String> {
    let hash = value.to_ascii_lowercase();
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request("sha256"));
    }
    Ok(hash)
}

/// Reads a raw file body. Honours the route's `DefaultBodyLimit`; an oversized body is 413.
async fn read_file_body(state: &AppState, request: Request) -> ApiResult<Bytes> {
    let bytes = Bytes::from_request(request, state)
        .await
        .map_err(|rejection| {
            if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                too_large_file(state)
            } else {
                ApiError::bad_request("body")
            }
        })?;
    if bytes.len() > state.config.max_file_bytes {
        return Err(too_large_file(state));
    }
    Ok(bytes)
}

/// Checks the declared hash and the type's signature; returns the hash.
fn verified_hash(bytes: &[u8], declared: &str, signature: &[u8]) -> ApiResult<String> {
    let hash = crypto::sha256_hex(bytes);
    if hash != declared {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            file_codes::HASH_MISMATCH,
        ));
    }
    if !bytes.starts_with(signature) {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            file_codes::UNSUPPORTED,
        ));
    }
    Ok(hash)
}

async fn store_file_blob(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    hash: &str,
    mime: &str,
    bytes: &[u8],
) -> ApiResult<()> {
    // `DO UPDATE` locks an existing row (see `drop_blob_if_unreferenced`).
    sqlx::query(
        "INSERT INTO file_blobs (hash, size, mime, bytes) VALUES ($1, $2, $3, $4) ON CONFLICT (hash) DO UPDATE SET hash = EXCLUDED.hash",
    )
    .bind(hash)
    .bind(bytes.len() as i64)
    .bind(mime)
    .bind(bytes)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Creates a binary document from the raw request body (`application/octet-stream`). The bytes are
/// checked against `sha256`, the MIME allow-list and its signature; they are both the current
/// content and the document's original. The route has its own body limit (`MAX_FILE_BYTES`); the
/// body is read only after the authorization check.
pub async fn upload_file(
    State(state): State<AppState>,
    user: AuthUser,
    Path(library_id): Path<Uuid>,
    query: Result<Query<UploadFileQuery>, axum::extract::rejection::QueryRejection>,
    headers: HeaderMap,
    request: Request,
) -> ApiResult<Response> {
    require_role(&state.db, &user, library_id, Role::Editor).await?;
    let Query(q) = query.map_err(|_| ApiError::bad_request("query"))?;
    let key = idempotency_key(&headers)?;
    if let Some(response) = replay(&state, &user, key).await? {
        return Ok(response);
    }
    let signature = signature_for(&q.mime)?;
    let file_name = valid_file_name(&q.file_name)?;
    let declared_hash = valid_sha256(&q.sha256)?;
    let bytes = read_file_body(&state, request).await?;
    let hash = verified_hash(&bytes, &declared_hash, signature)?;
    let title = file_title(file_name);
    let revision_id = Uuid::now_v7();

    let mut tx = state.db.begin().await?;
    let folder_id = match q.folder_id {
        Some(f) if is_live_folder(&mut tx, library_id, f).await? => Some(f),
        _ => None,
    };
    store_file_blob(&mut tx, &hash, &q.mime, &bytes).await?;
    // The imported bytes are also the document's original (kept while the document exists).
    let sql = format!(
        "INSERT INTO documents (id, library_id, folder_id, title, file_name, head_revision_id, content_hash, original_hash, kind, mime, search)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'file', $8, {}) ON CONFLICT (id) DO NOTHING RETURNING {DOC_COLUMNS}",
        SEARCH_VECTOR.replace("$T", "$4").replace("$C", "''")
    );
    let row: Option<DocRow> = sqlx::query_as(&sql)
        .bind(q.id)
        .bind(library_id)
        .bind(folder_id)
        .bind(&title)
        .bind(file_name)
        .bind(revision_id)
        .bind(&hash)
        .bind(&q.mime)
        .fetch_optional(&mut *tx)
        .await?;
    // An existing ID (possibly in another library) is a client bug or a probe: never overwrite.
    let row = row.ok_or_else(|| ApiError::new(StatusCode::CONFLICT, codes::CONFLICT))?;
    let info: DocInfo = row.into();
    let response = serde_json::to_value(&info).map_err(|_| ApiError::internal())?;
    record_op(&mut tx, &user, key, StatusCode::CREATED, &response).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(response)).into_response())
}

#[derive(Deserialize)]
pub struct ReplaceFileQuery {
    /// Head the client edited; anything else is `sync.conflict` (compare-and-swap).
    base_revision_id: Uuid,
    sha256: String,
}

/// Replaces the bytes of a binary document (an edit in Mavyn): same checks as the upload, plus
/// compare-and-swap on `base_revision_id`. No history: the previous bytes are deleted unless the
/// original or another document still uses them.
pub async fn replace_file(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    query: Result<Query<ReplaceFileQuery>, axum::extract::rejection::QueryRejection>,
    headers: HeaderMap,
    request: Request,
) -> ApiResult<Response> {
    require_document_role(&state.db, &user, id, Role::Editor).await?;
    let Query(q) = query.map_err(|_| ApiError::bad_request("query"))?;
    let key = idempotency_key(&headers)?;
    if let Some(response) = replay(&state, &user, key).await? {
        return Ok(response);
    }
    let declared_hash = valid_sha256(&q.sha256)?;
    let bytes = read_file_body(&state, request).await?;

    let mut tx = state.db.begin().await?;
    let (head, kind, mime, deleted, previous): (
        Uuid,
        String,
        Option<String>,
        Option<OffsetDateTime>,
        String,
    ) = sqlx::query_as(
        "SELECT head_revision_id, kind, mime, deleted_at, content_hash FROM documents WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if deleted.is_some() {
        return Err(ApiError::not_found(codes::DOCUMENT_NOT_FOUND));
    }
    let mime = match (kind.as_str(), mime) {
        (KIND_FILE, Some(mime)) => mime,
        _ => return Err(ApiError::new(StatusCode::CONFLICT, file_codes::NOT_FILE)),
    };
    let hash = verified_hash(&bytes, &declared_hash, signature_for(&mime)?)?;
    if head != q.base_revision_id {
        let details = ConflictDetails {
            head_revision_id: head,
            content_hash: previous,
        };
        return Err(ApiError::new(StatusCode::CONFLICT, codes::CONFLICT)
            .with_details(serde_json::to_value(details).unwrap_or_default()));
    }
    store_file_blob(&mut tx, &hash, &mime, &bytes).await?;
    let row: DocRow = sqlx::query_as(&format!(
        "UPDATE documents SET head_revision_id = $2, content_hash = $3, updated_at = now(),
         change_seq = nextval('change_seq') WHERE id = $1 RETURNING {DOC_COLUMNS}"
    ))
    .bind(id)
    .bind(Uuid::now_v7())
    .bind(&hash)
    .fetch_one(&mut *tx)
    .await?;
    if previous != hash {
        drop_blob_if_unreferenced(&mut tx, BlobTable::File, &previous).await?;
    }
    let info: DocInfo = row.into();
    let response = serde_json::to_value(&info).map_err(|_| ApiError::internal())?;
    record_op(&mut tx, &user, key, StatusCode::OK, &response).await?;
    tx.commit().await?;
    Ok((StatusCode::OK, Json(response)).into_response())
}

/// Bytes of a binary document. Always `application/octet-stream` + `nosniff`, so a browser never
/// renders an uploaded file (HTML disguised as PDF, etc.) in the app's origin; the real MIME type is
/// in the document metadata.
pub async fn download_file(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Response> {
    send_file_blob(&state, &user, id, "content_hash").await
}

/// The bytes a binary document was imported with ("Restore original" opens them as a copy).
pub async fn download_original(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Response> {
    send_file_blob(&state, &user, id, "original_hash").await
}

async fn send_file_blob(
    state: &AppState,
    user: &AuthUser,
    id: Uuid,
    column: &'static str,
) -> ApiResult<Response> {
    require_document_role(&state.db, user, id, Role::Viewer).await?;
    let (kind, hash): (String, Option<String>) = sqlx::query_as(&format!(
        "SELECT kind, {column} FROM documents WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    if kind != KIND_FILE {
        return Err(ApiError::new(StatusCode::CONFLICT, file_codes::NOT_FILE));
    }
    let hash = hash.ok_or_else(|| ApiError::not_found(codes::DOCUMENT_NOT_FOUND))?;
    let bytes: Vec<u8> = sqlx::query_scalar("SELECT bytes FROM file_blobs WHERE hash = $1")
        .bind(&hash)
        .fetch_one(&state.db)
        .await?;
    let headers = [
        (
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        ),
        (
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ),
        (header::CONTENT_LENGTH, HeaderValue::from(bytes.len())),
    ];
    Ok((StatusCode::OK, headers, bytes).into_response())
}

pub async fn get(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<DocWithContent>> {
    require_document_role(&state.db, &user, id, Role::Viewer).await?;
    let row: DocRow = sqlx::query_as(&format!(
        "SELECT {DOC_COLUMNS} FROM documents WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    if row.kind != KIND_TEXT {
        return Err(ApiError::new(StatusCode::CONFLICT, file_codes::NOT_TEXT));
    }
    let content: String = sqlx::query_scalar("SELECT content FROM blobs WHERE hash = $1")
        .bind(&row.content_hash)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(DocWithContent {
        document: row.into(),
        content,
    }))
}

/// Compare-and-swap update: succeeds only when `base_revision_id` is the head. Otherwise 409 with
/// the current head so the client can three-way merge or keep both versions.
pub async fn update_content(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<UpdateContentRequest>,
) -> ApiResult<Response> {
    require_document_role(&state.db, &user, id, Role::Editor).await?;
    let key = idempotency_key(&headers)?;
    if let Some(response) = replay(&state, &user, key).await? {
        return Ok(response);
    }
    check_size(&state, &body.content)?;
    if crypto::sha256_hex(body.content.as_bytes()) != body.content_hash.to_ascii_lowercase() {
        return Err(ApiError::bad_request("content_hash"));
    }

    let mut tx = state.db.begin().await?;
    let (head, file_name, deleted, kind, previous_hash): (
        Uuid,
        String,
        Option<OffsetDateTime>,
        String,
        String,
    ) = sqlx::query_as(
            "SELECT head_revision_id, file_name, deleted_at, kind, content_hash FROM documents WHERE id = $1 FOR UPDATE",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if deleted.is_some() {
        return Err(ApiError::not_found(codes::DOCUMENT_NOT_FOUND));
    }
    if kind != KIND_TEXT {
        return Err(ApiError::new(StatusCode::CONFLICT, file_codes::NOT_TEXT));
    }
    if head != body.base_revision_id {
        let details = ConflictDetails {
            head_revision_id: head,
            content_hash: previous_hash,
        };
        return Err(ApiError::new(StatusCode::CONFLICT, codes::CONFLICT)
            .with_details(serde_json::to_value(details).unwrap_or_default()));
    }

    let hash = store_blob(&mut tx, &body.content).await?;
    // `head_revision_id` is only a version token for compare-and-swap now; no history row.
    let revision_id = Uuid::now_v7();
    let title = derive_title(&body.content, &file_name);
    let sql = format!(
        "UPDATE documents SET head_revision_id = $2, content_hash = $3, title = $4, updated_at = now(),
         change_seq = nextval('change_seq'), search = {} WHERE id = $1 RETURNING {DOC_COLUMNS}",
        SEARCH_VECTOR.replace("$T", "$4").replace("$C", "$5")
    );
    let row: DocRow = sqlx::query_as(&sql)
        .bind(id)
        .bind(revision_id)
        .bind(&hash)
        .bind(&title)
        .bind(&body.content)
        .fetch_one(&mut *tx)
        .await?;
    if previous_hash != hash {
        drop_blob_if_unreferenced(&mut tx, BlobTable::Text, &previous_hash).await?;
    }
    let info: DocInfo = row.into();
    let response = serde_json::to_value(&info).map_err(|_| ApiError::internal())?;
    record_op(&mut tx, &user, key, StatusCode::OK, &response).await?;
    tx.commit().await?;
    Ok((StatusCode::OK, Json(response)).into_response())
}

/// Renames and/or moves a document (field-wise compare-and-swap, see `UpdateDocumentMetaRequest`).
/// The content is untouched; other devices learn about it from the change feed.
pub async fn update_meta(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateDocumentMetaRequest>,
) -> ApiResult<Json<DocInfo>> {
    let (library_id, _) = require_document_role(&state.db, &user, id, Role::Editor).await?;
    let file_name = valid_file_name(&body.file_name)?;
    let wanted_encoding = match &body.encoding {
        Some(label) => Some(valid_encoding(Some(label))?),
        None => None,
    };
    let base_encoding = valid_encoding(body.base_encoding.as_deref())?;
    let mut tx = state.db.begin().await?;
    lock_library(&mut tx, library_id).await?;
    let row: DocRow = sqlx::query_as(&format!(
        "SELECT {DOC_COLUMNS} FROM documents WHERE id = $1 FOR UPDATE"
    ))
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if row.deleted_at.is_some() {
        return Err(ApiError::not_found(codes::DOCUMENT_NOT_FOUND));
    }
    let new_name = if file_name != body.base_file_name && row.file_name == body.base_file_name {
        file_name.to_owned()
    } else {
        row.file_name.clone()
    };
    let move_ok = match body.folder_id {
        None => true,
        Some(f) => is_live_folder(&mut tx, library_id, f).await?,
    };
    let new_folder =
        if body.folder_id != body.base_folder_id && row.folder_id == body.base_folder_id && move_ok
        {
            body.folder_id
        } else {
            row.folder_id
        };
    let new_encoding = match wanted_encoding {
        Some(wanted)
            if wanted != row.encoding && row.encoding == base_encoding && row.kind == KIND_TEXT =>
        {
            wanted
        }
        _ => row.encoding.clone(),
    };
    if new_name == row.file_name && new_folder == row.folder_id && new_encoding == row.encoding {
        return Ok(Json(row.into()));
    }
    // Binary documents have no text: title and search come from the file name alone.
    let (title, content) = if row.kind == KIND_TEXT {
        let content: String = sqlx::query_scalar("SELECT content FROM blobs WHERE hash = $1")
            .bind(&row.content_hash)
            .fetch_one(&mut *tx)
            .await?;
        (derive_title(&content, &new_name), content)
    } else {
        (file_title(&new_name), String::new())
    };
    let sql = format!(
        "UPDATE documents SET file_name = $2, folder_id = $3, title = $4, encoding = $6, updated_at = now(),
         change_seq = nextval('change_seq'), search = {} WHERE id = $1 RETURNING {DOC_COLUMNS}",
        SEARCH_VECTOR.replace("$T", "$4").replace("$C", "$5")
    );
    let row: DocRow = sqlx::query_as(&sql)
        .bind(id)
        .bind(&new_name)
        .bind(new_folder)
        .bind(&title)
        .bind(&content)
        .bind(&new_encoding)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(row.into()))
}

/// Soft delete: leaves a tombstone in the change feed so other devices remove their copies.
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    require_document_role(&state.db, &user, id, Role::Editor).await?;
    sqlx::query("UPDATE documents SET deleted_at = now(), updated_at = now(), change_seq = nextval('change_seq') WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ChangesQuery {
    cursor: Option<String>,
    limit: Option<i64>,
}

/// Cursor-based change feed (upserts and tombstones) for incremental sync.
pub async fn changes(
    State(state): State<AppState>,
    user: AuthUser,
    Path(library_id): Path<Uuid>,
    Query(q): Query<ChangesQuery>,
) -> ApiResult<Json<DocChangesResponse>> {
    require_role(&state.db, &user, library_id, Role::Viewer).await?;
    let after: i64 = match q.cursor.as_deref() {
        None | Some("") => 0,
        Some(c) => c.parse().map_err(|_| ApiError::bad_request("cursor"))?,
    };
    let limit = q.limit.unwrap_or(500).clamp(1, 1000);
    let documents: Vec<DocRowSeq> = sqlx::query_as(&format!(
        "SELECT change_seq, {DOC_COLUMNS} FROM documents
         WHERE library_id = $1 AND change_seq > $2 ORDER BY change_seq LIMIT $3"
    ))
    .bind(library_id)
    .bind(after)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let folders: Vec<FolderRowSeq> = sqlx::query_as(&format!(
        "SELECT change_seq, {FOLDER_COLUMNS} FROM folders WHERE library_id = $1 AND change_seq > $2 ORDER BY change_seq LIMIT $3"
    ))
    .bind(library_id)
    .bind(after)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    // Both tables draw from one sequence: take the first `limit` changes across them.
    let mut seqs: Vec<i64> = documents
        .iter()
        .map(|d| d.change_seq)
        .chain(folders.iter().map(|f| f.change_seq))
        .collect();
    seqs.sort_unstable();
    let has_more = seqs.len() as i64 > limit;
    let last = if has_more {
        seqs[limit as usize - 1]
    } else {
        seqs.last().copied().unwrap_or(after)
    };
    Ok(Json(DocChangesResponse {
        documents: documents
            .into_iter()
            .filter(|d| d.change_seq <= last)
            .map(Into::into)
            .collect(),
        folders: folders
            .into_iter()
            .filter(|f| f.change_seq <= last)
            .map(|f| f.folder.into())
            .collect(),
        cursor: last.to_string(),
        has_more,
    }))
}

#[derive(sqlx::FromRow)]
struct FolderRowSeq {
    change_seq: i64,
    #[sqlx(flatten)]
    folder: FolderRow,
}

#[derive(sqlx::FromRow)]
struct DocRowSeq {
    change_seq: i64,
    #[sqlx(flatten)]
    doc: DocRow,
}

impl From<DocRowSeq> for DocInfo {
    fn from(r: DocRowSeq) -> Self {
        r.doc.into()
    }
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
}

/// Prefix full-text search. Only letters/digits reach `to_tsquery`, so user input cannot inject
/// tsquery operators. Binary documents are indexed by title alone, and their
/// snippet is the highlighted title.
pub async fn search(
    State(state): State<AppState>,
    user: AuthUser,
    Path(library_id): Path<Uuid>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<Vec<SearchHit>>> {
    require_role(&state.db, &user, library_id, Role::Viewer).await?;
    let terms: Vec<String> =
        q.q.split(|c: char| !c.is_alphanumeric())
            .filter(|t| !t.is_empty())
            .take(8)
            .map(|t| format!("{}:*", t.to_lowercase().replace('ё', "е")))
            .collect();
    if terms.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let query = terms.join(" & ");
    let rows: Vec<(Uuid, String, String, f32)> = sqlx::query_as(
        "SELECT d.id, d.title,
                ts_headline('simple', coalesce(left(b.content, 262144), d.title), to_tsquery('simple', $2), 'StartSel=⟦, StopSel=⟧, MaxWords=24, MinWords=8'),
                ts_rank(d.search, to_tsquery('simple', $2))
         FROM documents d LEFT JOIN blobs b ON d.kind = 'text' AND b.hash = d.content_hash
         WHERE d.library_id = $1 AND d.deleted_at IS NULL AND d.search @@ to_tsquery('simple', $2)
         ORDER BY 4 DESC LIMIT 50",
    )
    .bind(library_id)
    .bind(&query)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(document_id, title, snippet, rank)| SearchHit {
                document_id,
                title,
                snippet,
                rank,
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::derive_title;

    #[test]
    fn titles() {
        assert_eq!(derive_title("text\n## Заметки ##\n", "a.md"), "Заметки");
        assert_eq!(derive_title("    # code", "notes.md"), "notes");
        assert_eq!(derive_title("#nospace", "x.markdown"), "x");
        assert_eq!(derive_title("# comment\nprint(1)", "main.py"), "main.py");
        assert_eq!(derive_title("anything", "Dockerfile"), "Dockerfile");
    }
}
