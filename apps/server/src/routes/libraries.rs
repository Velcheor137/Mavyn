use crate::auth::{require_role, AuthUser};
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use mdr_domain::{codes, Role};
use mdr_sync_protocol::{AddMemberRequest, CreateLibraryRequest, LibraryInfo, MemberInfo};
use uuid::Uuid;

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<LibraryInfo>>> {
    let rows: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT l.id, l.name, m.role FROM libraries l JOIN library_members m ON m.library_id = l.id
         WHERE m.user_id = $1 ORDER BY l.name",
    )
    .bind(user.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .filter_map(|(id, name, role)| {
                Some(LibraryInfo {
                    id,
                    name,
                    role: role.parse().ok()?,
                })
            })
            .collect(),
    ))
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateLibraryRequest>,
) -> ApiResult<Response> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::bad_request("name"));
    }
    let id = Uuid::now_v7();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO libraries (id, name, created_by) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(name)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO library_members (library_id, user_id, role) VALUES ($1, $2, 'owner')")
        .bind(id)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(LibraryInfo {
            id,
            name: name.to_owned(),
            role: Role::Owner,
        }),
    )
        .into_response())
}

pub async fn members(
    State(state): State<AppState>,
    user: AuthUser,
    Path(library_id): Path<Uuid>,
) -> ApiResult<Json<Vec<MemberInfo>>> {
    require_role(&state.db, &user, library_id, Role::Viewer).await?;
    let rows: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT u.id, u.username, m.role FROM library_members m JOIN users u ON u.id = m.user_id
         WHERE m.library_id = $1 ORDER BY u.username_key",
    )
    .bind(library_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .filter_map(|(user_id, username, role)| {
                Some(MemberInfo {
                    user_id,
                    username,
                    role: role.parse().ok()?,
                })
            })
            .collect(),
    ))
}

/// Adds a member or changes their role. Admins manage editors/viewers; only owners manage admins and owners.
pub async fn put_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path(library_id): Path<Uuid>,
    Json(body): Json<AddMemberRequest>,
) -> ApiResult<StatusCode> {
    let actor = require_role(&state.db, &user, library_id, Role::Admin).await?;
    if !actor.can_grant(body.role) {
        return Err(ApiError::forbidden());
    }
    let target: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE username_key = $1")
        .bind(crypto::username_key(&body.username))
        .fetch_optional(&state.db)
        .await?;
    let target = target.ok_or_else(|| ApiError::not_found(codes::USER_NOT_FOUND))?;

    let mut tx = state.db.begin().await?;
    let current: Option<String> = sqlx::query_scalar(
        "SELECT role FROM library_members WHERE library_id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(library_id)
    .bind(target)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(current) = current.and_then(|r| r.parse::<Role>().ok()) {
        if !actor.can_grant(current) {
            return Err(ApiError::forbidden());
        }
        if current == Role::Owner && body.role != Role::Owner {
            ensure_other_owner(&mut tx, library_id, target).await?;
        }
    }
    sqlx::query(
        "INSERT INTO library_members (library_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (library_id, user_id) DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(library_id)
    .bind(target)
    .bind(body.role.as_str())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((library_id, member_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    // Members may always leave; removing others needs a role that could have granted theirs.
    let actor = require_role(&state.db, &user, library_id, Role::Viewer).await?;
    let mut tx = state.db.begin().await?;
    let current: Option<String> = sqlx::query_scalar(
        "SELECT role FROM library_members WHERE library_id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(library_id)
    .bind(member_id)
    .fetch_optional(&mut *tx)
    .await?;
    let current = current
        .and_then(|r| r.parse::<Role>().ok())
        .ok_or_else(|| ApiError::not_found(codes::USER_NOT_FOUND))?;
    if member_id != user.user_id && !actor.can_grant(current) {
        return Err(ApiError::forbidden());
    }
    if current == Role::Owner {
        ensure_other_owner(&mut tx, library_id, member_id).await?;
    }
    sqlx::query("DELETE FROM library_members WHERE library_id = $1 AND user_id = $2")
        .bind(library_id)
        .bind(member_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn ensure_other_owner(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    library_id: Uuid,
    except: Uuid,
) -> ApiResult<()> {
    let owners: i64 = sqlx::query_scalar("SELECT count(*) FROM library_members WHERE library_id = $1 AND role = 'owner' AND user_id <> $2")
        .bind(library_id)
        .bind(except)
        .fetch_one(&mut **tx)
        .await?;
    if owners == 0 {
        return Err(ApiError::new(StatusCode::CONFLICT, codes::LAST_OWNER));
    }
    Ok(())
}
