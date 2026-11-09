use crate::auth::{require_document_role, require_role, AuthUser};
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::routes::folders::{is_live_folder, lock_library, FolderRow, FOLDER_COLUMNS};
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use mdr_domain::{codes, Role};
use mdr_sync_protocol::{
    ChangesResponse, ConflictDetails, CreateDocumentRequest, DocumentInfo, DocumentWithContent,
    RevisionInfo, SearchHit, UpdateContentRequest, UpdateDocumentMetaRequest,
};
use serde::Deserialize;
use serde_json::{json, Value};
use time::OffsetDateTime;
use uuid::Uuid;

const DOC_COLUMNS: &str = "id, library_id, folder_id, title, file_name, head_revision_id, content_hash, updated_at, deleted_at";

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
}

impl From<DocRow> for DocumentInfo {
    fn from(r: DocRow) -> Self {
        DocumentInfo {
            id: r.id,
            library_id: r.library_id,
            folder_id: r.folder_id,
            title: r.title,
            file_name: r.file_name,
            head_revision_id: r.head_revision_id,
            content_hash: r.content_hash,
            updated_at: r.updated_at,
            deleted_at: r.deleted_at,
        }
    }
}

/// First ATX heading, else the file name without its extension (mirrors `deriveTitle` in core).
pub fn derive_title(content: &str, file_name: &str) -> String {
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
    sqlx::query(
        "INSERT INTO blobs (hash, size, content) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING",
    )
    .bind(&hash)
    .bind(content.len() as i64)
    .bind(content)
    .execute(&mut **tx)
    .await?;
    Ok(hash)
}

/// Search vector over title + content; `ё` folded to `е` like the clients do.
const SEARCH_VECTOR: &str = "to_tsvector('simple', translate($T || ' ' || $C, 'Ёё', 'Ее'))";

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(library_id): Path<Uuid>,
) -> ApiResult<Json<Vec<DocumentInfo>>> {
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
        "INSERT INTO documents (id, library_id, folder_id, title, file_name, head_revision_id, content_hash, search)
         VALUES ($1, $2, $3, $4, $5, $6, $7, {}) ON CONFLICT (id) DO NOTHING RETURNING {DOC_COLUMNS}",
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
        .fetch_optional(&mut *tx)
        .await?;
    // An existing ID (possibly in another library) is a client bug or a probe: never overwrite.
    let row = row.ok_or_else(|| ApiError::new(StatusCode::CONFLICT, codes::CONFLICT))?;
    sqlx::query("INSERT INTO revisions (id, document_id, parent_revision_id, content_hash, author_id, reason) VALUES ($1, $2, NULL, $3, $4, 'import')")
        .bind(revision_id)
        .bind(body.id)
        .bind(&hash)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;
    let info: DocumentInfo = row.into();
    let response = serde_json::to_value(&info).map_err(|_| ApiError::internal())?;
    record_op(&mut tx, &user, key, StatusCode::CREATED, &response).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(response)).into_response())
}

pub async fn get(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<DocumentWithContent>> {
    require_document_role(&state.db, &user, id, Role::Viewer).await?;
    let row: DocRow = sqlx::query_as(&format!(
        "SELECT {DOC_COLUMNS} FROM documents WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    let content: String = sqlx::query_scalar("SELECT content FROM blobs WHERE hash = $1")
        .bind(&row.content_hash)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(DocumentWithContent {
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
    let (head, file_name, deleted): (Uuid, String, Option<OffsetDateTime>) = sqlx::query_as(
        "SELECT head_revision_id, file_name, deleted_at FROM documents WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if deleted.is_some() {
        return Err(ApiError::not_found(codes::DOCUMENT_NOT_FOUND));
    }
    if head != body.base_revision_id {
        let current_hash: String =
            sqlx::query_scalar("SELECT content_hash FROM documents WHERE id = $1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        let details = ConflictDetails {
            head_revision_id: head,
            content_hash: current_hash,
        };
        return Err(ApiError::new(StatusCode::CONFLICT, codes::CONFLICT)
            .with_details(serde_json::to_value(details).unwrap_or_default()));
    }

    let hash = store_blob(&mut tx, &body.content).await?;
    let revision_id = Uuid::now_v7();
    sqlx::query("INSERT INTO revisions (id, document_id, parent_revision_id, content_hash, author_id, reason) VALUES ($1, $2, $3, $4, $5, 'edit')")
        .bind(revision_id)
        .bind(id)
        .bind(head)
        .bind(&hash)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;
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
    let info: DocumentInfo = row.into();
    let response = serde_json::to_value(&info).map_err(|_| ApiError::internal())?;
    record_op(&mut tx, &user, key, StatusCode::OK, &response).await?;
    tx.commit().await?;
    Ok((StatusCode::OK, Json(response)).into_response())
}

/// Renames and/or moves a document (field-wise compare-and-swap, see `UpdateDocumentMetaRequest`).
/// Text and history are untouched; other devices learn about it from the change feed.
pub async fn update_meta(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateDocumentMetaRequest>,
) -> ApiResult<Json<DocumentInfo>> {
    let (library_id, _) = require_document_role(&state.db, &user, id, Role::Editor).await?;
    let file_name = valid_file_name(&body.file_name)?;
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
    if new_name == row.file_name && new_folder == row.folder_id {
        return Ok(Json(row.into()));
    }
    let content: String = sqlx::query_scalar("SELECT content FROM blobs WHERE hash = $1")
        .bind(&row.content_hash)
        .fetch_one(&mut *tx)
        .await?;
    let title = derive_title(&content, &new_name);
    let sql = format!(
        "UPDATE documents SET file_name = $2, folder_id = $3, title = $4, updated_at = now(),
         change_seq = nextval('change_seq'), search = {} WHERE id = $1 RETURNING {DOC_COLUMNS}",
        SEARCH_VECTOR.replace("$T", "$4").replace("$C", "$5")
    );
    let row: DocRow = sqlx::query_as(&sql)
        .bind(id)
        .bind(&new_name)
        .bind(new_folder)
        .bind(&title)
        .bind(&content)
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

pub async fn revisions(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<RevisionInfo>>> {
    require_document_role(&state.db, &user, id, Role::Viewer).await?;
    let rows: Vec<RevisionRow> = sqlx::query_as(
        "SELECT r.id, r.parent_revision_id, r.content_hash, u.username AS author, r.reason, r.created_at
         FROM revisions r LEFT JOIN users u ON u.id = r.author_id WHERE r.document_id = $1 ORDER BY r.created_at DESC, r.id DESC",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| RevisionInfo {
                id: r.id,
                parent_revision_id: r.parent_revision_id,
                content_hash: r.content_hash,
                author: r.author,
                reason: r.reason,
                created_at: r.created_at,
            })
            .collect(),
    ))
}

#[derive(sqlx::FromRow)]
struct RevisionRow {
    id: Uuid,
    parent_revision_id: Option<Uuid>,
    content_hash: String,
    author: Option<String>,
    reason: String,
    created_at: OffsetDateTime,
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
) -> ApiResult<Json<ChangesResponse>> {
    require_role(&state.db, &user, library_id, Role::Viewer).await?;
    let after: i64 = match q.cursor.as_deref() {
        None | Some("") => 0,
        Some(c) => c.parse().map_err(|_| ApiError::bad_request("cursor"))?,
    };
    let limit = q.limit.unwrap_or(500).clamp(1, 1000);
    let documents: Vec<DocRowSeq> = sqlx::query_as(&format!(
        "SELECT change_seq, {DOC_COLUMNS} FROM documents WHERE library_id = $1 AND change_seq > $2 ORDER BY change_seq LIMIT $3"
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
    Ok(Json(ChangesResponse {
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

impl From<DocRowSeq> for DocumentInfo {
    fn from(r: DocRowSeq) -> Self {
        r.doc.into()
    }
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
}

/// Prefix full-text search. Only letters/digits reach `to_tsquery`, so user input cannot inject
/// tsquery operators.
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
                ts_headline('simple', b.content, to_tsquery('simple', $2), 'StartSel=⟦, StopSel=⟧, MaxWords=24, MinWords=8'),
                ts_rank(d.search, to_tsquery('simple', $2))
         FROM documents d JOIN blobs b ON b.hash = d.content_hash
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
    }
}
