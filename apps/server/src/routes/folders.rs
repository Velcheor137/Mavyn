use crate::auth::{require_folder_role, require_role, AuthUser};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use mdr_domain::{codes, Role};
use mdr_sync_protocol::{CreateFolderRequest, FolderInfo, UpdateFolderRequest};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

pub const FOLDER_COLUMNS: &str = "id, library_id, parent_id, name, updated_at, deleted_at";

#[derive(sqlx::FromRow)]
pub struct FolderRow {
    id: Uuid,
    library_id: Uuid,
    parent_id: Option<Uuid>,
    name: String,
    updated_at: OffsetDateTime,
    deleted_at: Option<OffsetDateTime>,
}

impl From<FolderRow> for FolderInfo {
    fn from(r: FolderRow) -> Self {
        FolderInfo {
            id: r.id,
            library_id: r.library_id,
            parent_id: r.parent_id,
            name: r.name,
            updated_at: r.updated_at,
            deleted_at: r.deleted_at,
        }
    }
}

fn valid_name(name: &str) -> ApiResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 255 || name.chars().any(char::is_control) {
        return Err(ApiError::bad_request("name"));
    }
    Ok(name)
}

/// Serialises tree changes within one library, so concurrent moves cannot form a cycle and a move
/// cannot target a folder that is being deleted.
pub async fn lock_library(tx: &mut Transaction<'_, Postgres>, library_id: Uuid) -> ApiResult<()> {
    sqlx::query("SELECT id FROM libraries WHERE id = $1 FOR UPDATE")
        .bind(library_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Whether `folder` is a live folder of `library` (a valid destination).
pub async fn is_live_folder(
    tx: &mut Transaction<'_, Postgres>,
    library_id: Uuid,
    folder: Uuid,
) -> ApiResult<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM folders WHERE id = $1 AND library_id = $2 AND deleted_at IS NULL)",
    )
    .bind(folder)
    .bind(library_id)
    .fetch_one(&mut **tx)
    .await?)
}

/// Whether `folder` may move under `parent`: the root, or a live folder that is not the folder
/// itself or one of its descendants.
async fn valid_parent(
    tx: &mut Transaction<'_, Postgres>,
    library_id: Uuid,
    folder: Uuid,
    parent: Option<Uuid>,
) -> ApiResult<bool> {
    let Some(parent) = parent else {
        return Ok(true);
    };
    if !is_live_folder(tx, library_id, parent).await? {
        return Ok(false);
    }
    let cycle: bool = sqlx::query_scalar(
        "WITH RECURSIVE up(id, parent_id) AS (
             SELECT id, parent_id FROM folders WHERE id = $1
             UNION SELECT f.id, f.parent_id FROM folders f JOIN up ON f.id = up.parent_id
         ) SELECT EXISTS(SELECT 1 FROM up WHERE id = $2)",
    )
    .bind(parent)
    .bind(folder)
    .fetch_one(&mut **tx)
    .await?;
    Ok(!cycle)
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(library_id): Path<Uuid>,
    Json(body): Json<CreateFolderRequest>,
) -> ApiResult<Response> {
    require_role(&state.db, &user, library_id, Role::Editor).await?;
    let name = valid_name(&body.name)?;
    let mut tx = state.db.begin().await?;
    lock_library(&mut tx, library_id).await?;

    let existing: Option<FolderRow> = sqlx::query_as(&format!(
        "SELECT {FOLDER_COLUMNS} FROM folders WHERE id = $1"
    ))
    .bind(body.id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(row) = existing {
        // A retried create. An id in another library is never revealed or reused.
        if row.library_id != library_id {
            return Err(ApiError::new(StatusCode::CONFLICT, codes::CONFLICT));
        }
        return Ok((StatusCode::OK, Json(FolderInfo::from(row))).into_response());
    }

    let parent = match body.parent_id {
        Some(p) if is_live_folder(&mut tx, library_id, p).await? => Some(p),
        _ => None,
    };
    let same_name: Option<FolderRow> = sqlx::query_as(&format!(
        "SELECT {FOLDER_COLUMNS} FROM folders WHERE library_id = $1 AND parent_id IS NOT DISTINCT FROM $2
         AND deleted_at IS NULL AND lower(name) = lower($3) ORDER BY created_at LIMIT 1"
    ))
    .bind(library_id)
    .bind(parent)
    .bind(name)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(row) = same_name {
        return Ok((StatusCode::OK, Json(FolderInfo::from(row))).into_response());
    }

    let row: FolderRow = sqlx::query_as(&format!(
        "INSERT INTO folders (id, library_id, parent_id, name) VALUES ($1, $2, $3, $4) RETURNING {FOLDER_COLUMNS}"
    ))
    .bind(body.id)
    .bind(library_id)
    .bind(parent)
    .bind(name)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(FolderInfo::from(row))).into_response())
}

pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateFolderRequest>,
) -> ApiResult<Json<FolderInfo>> {
    let (library_id, _) = require_folder_role(&state.db, &user, id, Role::Editor).await?;
    let name = valid_name(&body.name)?;
    let mut tx = state.db.begin().await?;
    lock_library(&mut tx, library_id).await?;
    let row: FolderRow = sqlx::query_as(&format!(
        "SELECT {FOLDER_COLUMNS} FROM folders WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if row.deleted_at.is_some() {
        return Err(ApiError::not_found(codes::FOLDER_NOT_FOUND));
    }
    let new_name = if name != body.base_name && row.name == body.base_name {
        name.to_owned()
    } else {
        row.name.clone()
    };
    let new_parent = if body.parent_id != body.base_parent_id
        && row.parent_id == body.base_parent_id
        && valid_parent(&mut tx, library_id, id, body.parent_id).await?
    {
        body.parent_id
    } else {
        row.parent_id
    };
    if new_name == row.name && new_parent == row.parent_id {
        return Ok(Json(row.into()));
    }
    let row: FolderRow = sqlx::query_as(&format!(
        "UPDATE folders SET name = $2, parent_id = $3, updated_at = now(), change_seq = nextval('change_seq')
         WHERE id = $1 RETURNING {FOLDER_COLUMNS}"
    ))
    .bind(id)
    .bind(&new_name)
    .bind(new_parent)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(row.into()))
}

/// Soft-deletes the folder, its subfolders and their documents, leaving tombstones in the change
/// feed. Repeating it is harmless.
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let (library_id, _) = require_folder_role(&state.db, &user, id, Role::Editor).await?;
    let mut tx = state.db.begin().await?;
    lock_library(&mut tx, library_id).await?;
    const SUBTREE: &str = "WITH RECURSIVE sub(id) AS (
        SELECT id FROM folders WHERE id = $1
        UNION SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id WHERE f.library_id = $2
    )";
    sqlx::query(&format!(
        "{SUBTREE} UPDATE documents SET deleted_at = now(), updated_at = now(), change_seq = nextval('change_seq')
         WHERE library_id = $2 AND deleted_at IS NULL AND folder_id IN (SELECT id FROM sub)"
    ))
    .bind(id)
    .bind(library_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!(
        "{SUBTREE} UPDATE folders SET deleted_at = now(), updated_at = now(), change_seq = nextval('change_seq')
         WHERE deleted_at IS NULL AND id IN (SELECT id FROM sub)"
    ))
    .bind(id)
    .bind(library_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
