//! API keys (`mvn_…`): server administrators create them for themselves on the website, for scripts
//! and MCP clients. Managed only from a signed-in session, never with a key.

use crate::auth::{AuthUser, TokenAccess, TOKEN_PREFIX};
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use mdr_domain::codes;
use mdr_sync_protocol::{ApiTokenInfo, CreateApiTokenRequest, CreatedApiToken};
use time::OffsetDateTime;
use uuid::Uuid;

/// Lifetimes offered on creation (days); `null` means no expiry.
const LIFETIMES: [u32; 3] = [30, 90, 365];

/// Signed-in server administrator; anything else is refused.
fn admin_session(user: &AuthUser) -> ApiResult<()> {
    user.session()?;
    if !user.is_admin {
        return Err(ApiError::forbidden());
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct TokenRow {
    id: Uuid,
    name: String,
    hint: String,
    access: String,
    can_delete: bool,
    all_libraries: bool,
    library_ids: Vec<Uuid>,
    created_at: OffsetDateTime,
    last_used_at: Option<OffsetDateTime>,
    expires_at: Option<OffsetDateTime>,
}

impl From<TokenRow> for ApiTokenInfo {
    fn from(r: TokenRow) -> Self {
        ApiTokenInfo {
            id: r.id,
            name: r.name,
            hint: r.hint,
            access: r.access,
            can_delete: r.can_delete,
            all_libraries: r.all_libraries,
            library_ids: r.library_ids,
            created_at: r.created_at,
            last_used_at: r.last_used_at,
            expires_at: r.expires_at,
        }
    }
}

const TOKEN_SELECT: &str = "SELECT t.id, t.name, t.hint, t.access, t.can_delete, t.all_libraries,
        COALESCE(ARRAY(SELECT library_id FROM api_token_libraries l WHERE l.token_id = t.id ORDER BY library_id), '{}') AS library_ids,
        t.created_at, t.last_used_at, t.expires_at
    FROM api_tokens t";

/// The caller's usable keys (not revoked, not expired), newest first.
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<ApiTokenInfo>>> {
    admin_session(&user)?;
    let rows: Vec<TokenRow> = sqlx::query_as(&format!(
        "{TOKEN_SELECT} WHERE t.user_id = $1 AND t.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > now()) ORDER BY t.created_at DESC"
    ))
    .bind(user.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

/// Creates a key and returns it once. Chosen libraries must be ones the caller belongs to.
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateApiTokenRequest>,
) -> ApiResult<Response> {
    admin_session(&user)?;
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(ApiError::bad_request("name"));
    }
    let access = TokenAccess::parse(&body.access).ok_or_else(|| ApiError::bad_request("access"))?;
    if body.can_delete && access != TokenAccess::Write {
        return Err(ApiError::bad_request("can_delete"));
    }
    let expires_at = match body.expires_in_days {
        None => None,
        Some(days) if LIFETIMES.contains(&days) => {
            Some(OffsetDateTime::now_utc() + time::Duration::days(i64::from(days)))
        }
        Some(_) => return Err(ApiError::bad_request("expires_in_days")),
    };
    let mut library_ids = body.library_ids.clone();
    library_ids.sort_unstable();
    library_ids.dedup();
    if body.all_libraries != library_ids.is_empty() || library_ids.len() > 1000 {
        return Err(ApiError::bad_request("library_ids"));
    }

    let mut tx = state.db.begin().await?;
    if !library_ids.is_empty() {
        let member_of: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM library_members WHERE user_id = $1 AND library_id = ANY($2)",
        )
        .bind(user.user_id)
        .bind(&library_ids)
        .fetch_one(&mut *tx)
        .await?;
        if member_of != library_ids.len() as i64 {
            return Err(ApiError::not_found(codes::LIBRARY_NOT_FOUND));
        }
    }
    let token = format!("{TOKEN_PREFIX}{}", crypto::random_token());
    let hint: String = token[token.len() - 4..].to_owned();
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO api_tokens (id, user_id, name, token_hash, hint, access, can_delete, all_libraries, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(id)
    .bind(user.user_id)
    .bind(name)
    .bind(crypto::sha256(token.as_bytes()))
    .bind(&hint)
    .bind(access.as_str())
    .bind(body.can_delete)
    .bind(body.all_libraries)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO api_token_libraries (token_id, library_id) SELECT $1, unnest($2::uuid[])",
    )
    .bind(id)
    .bind(&library_ids)
    .execute(&mut *tx)
    .await?;
    let row: TokenRow = sqlx::query_as(&format!("{TOKEN_SELECT} WHERE t.id = $1"))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(user_id = %user.user_id, token_id = %id, "API key created");
    Ok((
        StatusCode::CREATED,
        Json(CreatedApiToken {
            token,
            info: row.into(),
        }),
    )
        .into_response())
}

/// Revokes one of the caller's keys; it stops working immediately.
pub async fn revoke(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    admin_session(&user)?;
    let result = sqlx::query(
        "UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(id)
    .bind(user.user_id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(codes::TOKEN_NOT_FOUND));
    }
    tracing::info!(user_id = %user.user_id, token_id = %id, "API key revoked");
    Ok(StatusCode::NO_CONTENT)
}
