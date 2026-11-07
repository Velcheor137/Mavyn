use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{ConnectInfo, FromRef, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, Method, StatusCode};
use mdr_domain::{codes, Role};
use sqlx::PgPool;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

/// An authenticated request. Browser (cookie) requests with unsafe methods must also carry the
/// session's CSRF token and, when configured, a matching `Origin`.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: Uuid,
    pub session_id: Uuid,
    pub username: String,
    pub is_admin: bool,
    pub csrf_token: String,
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    session_id: Uuid,
    user_id: Uuid,
    username: String,
    is_admin: bool,
    csrf_token: String,
}

fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

impl<S> FromRequestParts<S> for AuthUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let state = AppState::from_ref(state);
        let (token, via_cookie) = match bearer(&parts.headers) {
            Some(token) => (token.to_owned(), false),
            None => match cookie_value(&parts.headers, state.config.cookie_name()) {
                Some(token) => (token.to_owned(), true),
                None => return Err(ApiError::unauthorized()),
            },
        };

        let row: Option<SessionRow> = sqlx::query_as(
            "UPDATE sessions s SET last_seen_at = now()
             FROM users u
             WHERE s.token_hash = $1 AND s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()
             RETURNING s.id AS session_id, u.id AS user_id, u.username, u.is_admin, s.csrf_token",
        )
        .bind(crypto::sha256(token.as_bytes()))
        .fetch_optional(&state.db)
        .await?;
        let row = row.ok_or_else(ApiError::unauthorized)?;

        let unsafe_method = !matches!(parts.method, Method::GET | Method::HEAD | Method::OPTIONS);
        if via_cookie && unsafe_method {
            if let (Some(expected), Some(origin)) = (&state.config.public_origin, parts.headers.get(header::ORIGIN)) {
                if origin.to_str().ok() != Some(expected.as_str()) {
                    return Err(ApiError::new(StatusCode::FORBIDDEN, codes::CSRF));
                }
            }
            let sent = parts.headers.get("x-csrf-token").and_then(|v| v.to_str().ok()).unwrap_or("");
            if !crypto::constant_time_eq(sent.as_bytes(), row.csrf_token.as_bytes()) {
                return Err(ApiError::new(StatusCode::FORBIDDEN, codes::CSRF));
            }
        }

        Ok(AuthUser { user_id: row.user_id, session_id: row.session_id, username: row.username, is_admin: row.is_admin, csrf_token: row.csrf_token })
    }
}

/// Role of `user` in `library`. Non-members get `library.not_found` so library IDs cannot be probed.
pub async fn require_role(db: &PgPool, user: &AuthUser, library_id: Uuid, min: Role) -> ApiResult<Role> {
    let role: Option<String> = sqlx::query_scalar("SELECT role FROM library_members WHERE library_id = $1 AND user_id = $2")
        .bind(library_id)
        .bind(user.user_id)
        .fetch_optional(db)
        .await?;
    let role = role
        .and_then(|r| r.parse::<Role>().ok())
        .ok_or_else(|| ApiError::not_found(codes::LIBRARY_NOT_FOUND))?;
    if role < min {
        return Err(ApiError::forbidden());
    }
    Ok(role)
}

/// Resolves a document's library and checks the role there. Documents in libraries the user cannot
/// see are reported as not found (IDOR protection).
pub async fn require_document_role(db: &PgPool, user: &AuthUser, document_id: Uuid, min: Role) -> ApiResult<(Uuid, Role)> {
    let library_id: Option<Uuid> = sqlx::query_scalar("SELECT library_id FROM documents WHERE id = $1")
        .bind(document_id)
        .fetch_optional(db)
        .await?;
    let library_id = library_id.ok_or_else(|| ApiError::not_found(codes::DOCUMENT_NOT_FOUND))?;
    match require_role(db, user, library_id, min).await {
        Ok(role) => Ok((library_id, role)),
        Err(e) if e.code == codes::LIBRARY_NOT_FOUND => Err(ApiError::not_found(codes::DOCUMENT_NOT_FOUND)),
        Err(e) => Err(e),
    }
}

/// Fixed-window limiter for authentication attempts, keyed by client IP and by username.
pub struct RateLimiter {
    window: Duration,
    max: u32,
    hits: Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    pub fn new(max: u32, window: Duration) -> Self {
        Self { window, max, hits: Mutex::new(HashMap::new()) }
    }

    /// Records an attempt; returns false when the key exceeded its budget.
    pub fn check(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut hits = self.hits.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if hits.len() > 10_000 {
            hits.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }
        let entry = hits.entry(key.to_owned()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= self.max
    }
}

pub fn client_ip(parts_headers: &HeaderMap, connect: Option<&ConnectInfo<SocketAddr>>, trust_proxy: bool) -> String {
    if trust_proxy {
        if let Some(ip) = parts_headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()) {
            return ip.trim().to_owned();
        }
    }
    connect.map_or_else(|| "unknown".to_owned(), |c| c.0.ip().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiter_blocks_after_budget() {
        let limiter = RateLimiter::new(2, Duration::from_secs(60));
        assert!(limiter.check("ip"));
        assert!(limiter.check("ip"));
        assert!(!limiter.check("ip"));
        assert!(limiter.check("other"));
    }

    #[test]
    fn parses_cookies() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "a=1; __Host-mdr_session=tok; b=2".parse().expect("header"));
        assert_eq!(cookie_value(&headers, "__Host-mdr_session"), Some("tok"));
        assert_eq!(cookie_value(&headers, "missing"), None);
    }
}
