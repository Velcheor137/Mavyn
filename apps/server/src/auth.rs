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

/// Prefix of API keys (`mvn_…`), so secret scanners and the extractor can tell them from sessions.
pub const TOKEN_PREFIX: &str = "mvn_";

/// Requests per minute one API key may make.
pub const TOKEN_RATE_PER_MINUTE: u32 = 600;

/// The ceiling an API key puts on its owner's library role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenAccess {
    Read,
    Write,
}

impl TokenAccess {
    pub const fn as_str(self) -> &'static str {
        match self {
            TokenAccess::Read => "read",
            TokenAccess::Write => "write",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "read" => Some(TokenAccess::Read),
            "write" => Some(TokenAccess::Write),
            _ => None,
        }
    }

    /// Highest library role the key may use.
    const fn cap(self) -> Role {
        match self {
            TokenAccess::Read => Role::Viewer,
            TokenAccess::Write => Role::Editor,
        }
    }
}

/// What an API key may do on top of its owner's own rights.
#[derive(Debug, Clone)]
pub struct TokenScope {
    pub token_id: Uuid,
    pub access: TokenAccess,
    pub can_delete: bool,
    /// `None`: every library the owner is a member of.
    pub libraries: Option<Vec<Uuid>>,
}

impl TokenScope {
    pub fn allows_library(&self, library_id: Uuid) -> bool {
        self.libraries
            .as_ref()
            .is_none_or(|ids| ids.contains(&library_id))
    }
}

/// How a request authenticated: a sign-in session (browser cookie or app bearer) or an API key.
#[derive(Debug, Clone)]
pub enum Credential {
    Session {
        session_id: Uuid,
        csrf_token: String,
    },
    Token(TokenScope),
}

/// An authenticated request. Browser (cookie) requests with unsafe methods must also carry the
/// session's CSRF token and, when configured, a matching `Origin`. API keys never use cookies, so
/// they need neither.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: Uuid,
    pub username: String,
    pub is_admin: bool,
    pub credential: Credential,
}

impl AuthUser {
    /// The sign-in session; API keys get `403 token.forbidden` (account, key and membership
    /// management stay with signed-in people).
    pub fn session(&self) -> ApiResult<(Uuid, &str)> {
        match &self.credential {
            Credential::Session {
                session_id,
                csrf_token,
            } => Ok((*session_id, csrf_token)),
            Credential::Token(_) => Err(token_forbidden()),
        }
    }

    pub fn token(&self) -> Option<&TokenScope> {
        match &self.credential {
            Credential::Token(scope) => Some(scope),
            Credential::Session { .. } => None,
        }
    }

    /// Deleting documents and folders: API keys need their "allow deletion" flag.
    pub fn require_delete(&self) -> ApiResult<()> {
        match self.token() {
            Some(scope) if !scope.can_delete => Err(token_forbidden()),
            _ => Ok(()),
        }
    }

    /// The role this request may use in a library where the user is a `member`: capped by an API
    /// key's access level, `None` for libraries outside the key's scope.
    pub fn effective_role(&self, library_id: Uuid, member: Role) -> Option<Role> {
        match self.token() {
            None => Some(member),
            Some(scope) if scope.allows_library(library_id) => Some(member.min(scope.access.cap())),
            Some(_) => None,
        }
    }
}

pub fn token_forbidden() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, codes::TOKEN_FORBIDDEN)
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    session_id: Uuid,
    user_id: Uuid,
    username: String,
    is_admin: bool,
    csrf_token: String,
}

#[derive(sqlx::FromRow)]
struct TokenRow {
    token_id: Uuid,
    access: String,
    can_delete: bool,
    all_libraries: bool,
    stale: bool,
    user_id: Uuid,
    username: String,
    is_admin: bool,
}

/// Resolves an API key. Valid while not revoked, not expired and while its owner is still a server
/// administrator (only administrators hold keys). Rate limited per key.
pub async fn authenticate_token(state: &AppState, token: &str) -> ApiResult<AuthUser> {
    let row: Option<TokenRow> = sqlx::query_as(
        "SELECT t.id AS token_id, t.access, t.can_delete, t.all_libraries,
                (t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 minute') AS stale,
                u.id AS user_id, u.username, u.is_admin
         FROM api_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = $1 AND t.revoked_at IS NULL
           AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.is_admin",
    )
    .bind(crypto::sha256(token.as_bytes()))
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or_else(ApiError::unauthorized)?;
    let access = TokenAccess::parse(&row.access).ok_or_else(ApiError::internal)?;
    if !state.token_limiter.check(&row.token_id.to_string()) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            codes::RATE_LIMITED,
        ));
    }
    let libraries = if row.all_libraries {
        None
    } else {
        Some(
            sqlx::query_scalar("SELECT library_id FROM api_token_libraries WHERE token_id = $1")
                .bind(row.token_id)
                .fetch_all(&state.db)
                .await?,
        )
    };
    // Written at most once a minute per key, not on every request.
    if row.stale {
        sqlx::query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1")
            .bind(row.token_id)
            .execute(&state.db)
            .await?;
    }
    Ok(AuthUser {
        user_id: row.user_id,
        username: row.username,
        is_admin: row.is_admin,
        credential: Credential::Token(TokenScope {
            token_id: row.token_id,
            access,
            can_delete: row.can_delete,
            libraries,
        }),
    })
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

pub fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

impl<S> FromRequestParts<S> for AuthUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let state = AppState::from_ref(state);
        if let Some(token) = bearer(&parts.headers).filter(|t| t.starts_with(TOKEN_PREFIX)) {
            return authenticate_token(&state, token).await;
        }
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
            if let (Some(expected), Some(origin)) = (
                &state.config.public_origin,
                parts.headers.get(header::ORIGIN),
            ) {
                if origin.to_str().ok() != Some(expected.as_str()) {
                    return Err(ApiError::new(StatusCode::FORBIDDEN, codes::CSRF));
                }
            }
            let sent = parts
                .headers
                .get("x-csrf-token")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if !crypto::constant_time_eq(sent.as_bytes(), row.csrf_token.as_bytes()) {
                return Err(ApiError::new(StatusCode::FORBIDDEN, codes::CSRF));
            }
        }

        Ok(AuthUser {
            user_id: row.user_id,
            username: row.username,
            is_admin: row.is_admin,
            credential: Credential::Session {
                session_id: row.session_id,
                csrf_token: row.csrf_token,
            },
        })
    }
}

/// Role of `user` in `library`. Non-members get `library.not_found` so library IDs cannot be probed;
/// so do libraries outside an API key's scope. An API key caps the role at its access level.
pub async fn require_role(
    db: &PgPool,
    user: &AuthUser,
    library_id: Uuid,
    min: Role,
) -> ApiResult<Role> {
    if user.token().is_some_and(|t| !t.allows_library(library_id)) {
        return Err(ApiError::not_found(codes::LIBRARY_NOT_FOUND));
    }
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM library_members WHERE library_id = $1 AND user_id = $2",
    )
    .bind(library_id)
    .bind(user.user_id)
    .fetch_optional(db)
    .await?;
    let role = role
        .and_then(|r| r.parse::<Role>().ok())
        .and_then(|r| user.effective_role(library_id, r))
        .ok_or_else(|| ApiError::not_found(codes::LIBRARY_NOT_FOUND))?;
    if role < min {
        // A key without write access says so; a too-low membership role stays `auth.forbidden`.
        return Err(match user.token() {
            Some(t) if min > t.access.cap() => token_forbidden(),
            _ => ApiError::forbidden(),
        });
    }
    Ok(role)
}

/// Resolves a document's library and checks the role there. Documents in libraries the user cannot
/// see are reported as not found (IDOR protection).
pub async fn require_document_role(
    db: &PgPool,
    user: &AuthUser,
    document_id: Uuid,
    min: Role,
) -> ApiResult<(Uuid, Role)> {
    let library_id: Option<Uuid> =
        sqlx::query_scalar("SELECT library_id FROM documents WHERE id = $1")
            .bind(document_id)
            .fetch_optional(db)
            .await?;
    let library_id = library_id.ok_or_else(|| ApiError::not_found(codes::DOCUMENT_NOT_FOUND))?;
    match require_role(db, user, library_id, min).await {
        Ok(role) => Ok((library_id, role)),
        Err(e) if e.code == codes::LIBRARY_NOT_FOUND => {
            Err(ApiError::not_found(codes::DOCUMENT_NOT_FOUND))
        }
        Err(e) => Err(e),
    }
}

/// Like [`require_document_role`] for folders.
pub async fn require_folder_role(
    db: &PgPool,
    user: &AuthUser,
    folder_id: Uuid,
    min: Role,
) -> ApiResult<(Uuid, Role)> {
    let library_id: Option<Uuid> =
        sqlx::query_scalar("SELECT library_id FROM folders WHERE id = $1")
            .bind(folder_id)
            .fetch_optional(db)
            .await?;
    let library_id = library_id.ok_or_else(|| ApiError::not_found(codes::FOLDER_NOT_FOUND))?;
    match require_role(db, user, library_id, min).await {
        Ok(role) => Ok((library_id, role)),
        Err(e) if e.code == codes::LIBRARY_NOT_FOUND => {
            Err(ApiError::not_found(codes::FOLDER_NOT_FOUND))
        }
        Err(e) => Err(e),
    }
}

/// Fixed-window limiter: authentication attempts (keyed by client IP and by username) and API-key
/// requests (keyed by key id).
pub struct RateLimiter {
    window: Duration,
    max: u32,
    hits: Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    pub fn new(max: u32, window: Duration) -> Self {
        Self {
            window,
            max,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Records an attempt; returns false when the key exceeded its budget.
    pub fn check(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut hits = self
            .hits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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

pub fn client_ip(
    parts_headers: &HeaderMap,
    connect: Option<&ConnectInfo<SocketAddr>>,
    trust_proxy: bool,
) -> String {
    if trust_proxy {
        if let Some(ip) = parts_headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
        {
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
        headers.insert(
            header::COOKIE,
            "a=1; __Host-mdr_session=tok; b=2".parse().expect("header"),
        );
        assert_eq!(cookie_value(&headers, "__Host-mdr_session"), Some("tok"));
        assert_eq!(cookie_value(&headers, "missing"), None);
    }
}
