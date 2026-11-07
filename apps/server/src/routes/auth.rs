use crate::auth::{client_ip, AuthUser};
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use mdr_domain::codes;
use mdr_sync_protocol::{CreateUserRequest, LoginRequest, LoginResponse, MeResponse, SessionInfo, SetupRequest, UserInfo};
use serde_json::json;
use sqlx::PgPool;
use std::net::SocketAddr;
use time::OffsetDateTime;
use uuid::Uuid;

/// Ensures a setup token exists while no user does, returning it so `main` can log it once.
/// No default credentials ever exist.
pub async fn bootstrap_setup_token(db: &PgPool) -> Result<Option<String>, sqlx::Error> {
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(db).await?;
    if users > 0 {
        return Ok(None);
    }
    let token = crypto::random_token();
    sqlx::query(
        "INSERT INTO setup_state (id, token_hash) VALUES (true, $1)
         ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash WHERE setup_state.completed_at IS NULL",
    )
    .bind(crypto::sha256(token.as_bytes()))
    .execute(db)
    .await?;
    Ok(Some(token))
}

pub async fn setup_status(State(state): State<AppState>) -> ApiResult<Json<serde_json::Value>> {
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(&state.db).await?;
    Ok(Json(json!({ "needs_setup": users == 0 })))
}

fn rate_limited() -> ApiError {
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, codes::RATE_LIMITED)
}

fn ip_of(state: &AppState, headers: &HeaderMap, connect: Option<&ConnectInfo<SocketAddr>>) -> String {
    client_ip(headers, connect, state.config.trust_proxy)
}

/// Creates the first administrator using the one-time setup token from the server log.
pub async fn setup(State(state): State<AppState>, request: Request) -> ApiResult<Response> {
    let ip = ip_of(&state, request.headers(), request.extensions().get());
    if !state.auth_limiter.check(&format!("setup:{ip}")) {
        return Err(rate_limited());
    }
    let body: SetupRequest = parse_json(request, state.config.max_document_bytes).await?;
    validate_credentials(&body.username, &body.password)?;

    let mut tx = state.db.begin().await?;
    let row: Option<(Option<Vec<u8>>, Option<OffsetDateTime>)> =
        sqlx::query_as("SELECT token_hash, completed_at FROM setup_state WHERE id FOR UPDATE").fetch_optional(&mut *tx).await?;
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(&mut *tx).await?;
    match row {
        _ if users > 0 => return Err(ApiError::new(StatusCode::CONFLICT, codes::SETUP_DONE)),
        Some((_, Some(_))) => return Err(ApiError::new(StatusCode::CONFLICT, codes::SETUP_DONE)),
        Some((Some(hash), None)) if crypto::constant_time_eq(&hash, &crypto::sha256(body.token.as_bytes())) => {}
        _ => return Err(ApiError::new(StatusCode::FORBIDDEN, codes::SETUP_TOKEN)),
    }

    let user_id = insert_user(&mut tx, &body.username, &body.password, true).await?;
    sqlx::query("UPDATE setup_state SET token_hash = NULL, completed_at = now() WHERE id").execute(&mut *tx).await?;
    tx.commit().await?;
    tracing::info!(%user_id, "initial administrator created; setup token invalidated");
    Ok((StatusCode::CREATED, Json(UserInfo { id: user_id, username: body.username, is_admin: true })).into_response())
}

async fn parse_json<T: serde::de::DeserializeOwned>(request: Request, limit: usize) -> ApiResult<T> {
    let bytes = axum::body::to_bytes(request.into_body(), limit)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, codes::TOO_LARGE))?;
    serde_json::from_slice(&bytes).map_err(|_| ApiError::bad_request("body"))
}

fn validate_credentials(username: &str, password: &str) -> ApiResult<()> {
    if !crypto::valid_username(username) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, codes::INVALID_USERNAME));
    }
    if !crypto::valid_password(password) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, codes::WEAK_PASSWORD).with_details(json!({ "min_length": 10 })));
    }
    Ok(())
}

async fn insert_user(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, username: &str, password: &str, is_admin: bool) -> ApiResult<Uuid> {
    let hash = crypto::hash_password(password).map_err(|_| ApiError::internal())?;
    let id = Uuid::now_v7();
    let result = sqlx::query("INSERT INTO users (id, username, username_key, password_hash, is_admin) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (username_key) DO NOTHING")
        .bind(id)
        .bind(username)
        .bind(crypto::username_key(username))
        .bind(hash)
        .bind(is_admin)
        .execute(&mut **tx)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::CONFLICT, codes::USERNAME_TAKEN));
    }
    Ok(id)
}

pub async fn login(State(state): State<AppState>, request: Request) -> ApiResult<Response> {
    let ip = ip_of(&state, request.headers(), request.extensions().get());
    let body: LoginRequest = parse_json(request, 64 * 1024).await?;
    let key = crypto::username_key(&body.username);
    if !state.auth_limiter.check(&format!("login-ip:{ip}")) || !state.auth_limiter.check(&format!("login-user:{key}")) {
        return Err(rate_limited());
    }

    let user: Option<(Uuid, String, String, bool)> =
        sqlx::query_as("SELECT id, username, password_hash, is_admin FROM users WHERE username_key = $1")
            .bind(&key)
            .fetch_optional(&state.db)
            .await?;
    // Always run Argon2 so response time does not reveal whether the username exists.
    let hash = user.as_ref().map_or(crypto::dummy_hash(), |u| u.2.as_str()).to_owned();
    let password = body.password.clone();
    let verified = tokio::task::spawn_blocking(move || crypto::verify_password(&password, &hash)).await.unwrap_or(false);
    let Some((user_id, username, _, is_admin)) = user.filter(|_| verified) else {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, codes::INVALID_CREDENTIALS));
    };

    let token = crypto::random_token();
    let csrf = crypto::random_token();
    let expires = OffsetDateTime::now_utc() + time::Duration::days(state.config.session_ttl_days);
    sqlx::query("INSERT INTO sessions (id, user_id, token_hash, csrf_token, device_name, expires_at) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(Uuid::now_v7())
        .bind(user_id)
        .bind(crypto::sha256(token.as_bytes()))
        .bind(&csrf)
        .bind(body.device_name.map(|d| d.chars().take(100).collect::<String>()))
        .bind(expires)
        .execute(&state.db)
        .await?;

    let cookie = session_cookie(&state, &token, state.config.session_ttl_days * 86_400);
    let response = LoginResponse { token, csrf_token: csrf, user: UserInfo { id: user_id, username, is_admin } };
    Ok(([(header::SET_COOKIE, cookie)], Json(response)).into_response())
}

fn session_cookie(state: &AppState, value: &str, max_age: i64) -> HeaderValue {
    let secure = if state.config.cookie_secure { "; Secure" } else { "" };
    let cookie = format!("{}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}", state.config.cookie_name());
    HeaderValue::from_str(&cookie).unwrap_or_else(|_| HeaderValue::from_static(""))
}

pub async fn logout(State(state): State<AppState>, user: AuthUser) -> ApiResult<Response> {
    sqlx::query("UPDATE sessions SET revoked_at = now() WHERE id = $1").bind(user.session_id).execute(&state.db).await?;
    Ok(([(header::SET_COOKIE, session_cookie(&state, "", 0))], StatusCode::NO_CONTENT).into_response())
}

pub async fn me(user: AuthUser) -> Json<MeResponse> {
    Json(MeResponse { user: UserInfo { id: user.user_id, username: user.username, is_admin: user.is_admin }, csrf_token: user.csrf_token })
}

pub async fn list_sessions(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<SessionInfo>>> {
    let rows: Vec<(Uuid, Option<String>, OffsetDateTime, OffsetDateTime)> = sqlx::query_as(
        "SELECT id, device_name, created_at, last_seen_at FROM sessions
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC",
    )
    .bind(user.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, device_name, created_at, last_seen_at)| SessionInfo { id, device_name, created_at, last_seen_at, current: id == user.session_id })
            .collect(),
    ))
}

/// Revokes one of the caller's own sessions (e.g. a lost device).
pub async fn revoke_session(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>) -> ApiResult<StatusCode> {
    let result = sqlx::query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL")
        .bind(id)
        .bind(user.user_id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(codes::SESSION_NOT_FOUND));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Administrators create accounts (no open registration).
pub async fn create_user(State(state): State<AppState>, user: AuthUser, Json(body): Json<CreateUserRequest>) -> ApiResult<Response> {
    if !user.is_admin {
        return Err(ApiError::forbidden());
    }
    validate_credentials(&body.username, &body.password)?;
    let mut tx = state.db.begin().await?;
    let id = insert_user(&mut tx, &body.username, &body.password, false).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(UserInfo { id, username: body.username, is_admin: false })).into_response())
}
