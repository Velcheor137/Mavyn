use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use mdr_domain::codes;
use mdr_sync_protocol::{ErrorBody, ErrorPayload};
use serde_json::{json, Value};

/// API error: an HTTP status plus a stable code. Never carries English prose for users.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub details: Value,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str) -> Self {
        Self {
            status,
            code,
            details: Value::Null,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    pub fn bad_request(field: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, codes::BAD_REQUEST)
            .with_details(json!({ "field": field }))
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, codes::AUTH_REQUIRED)
    }
    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, codes::FORBIDDEN)
    }
    pub fn not_found(code: &'static str) -> Self {
        Self::new(StatusCode::NOT_FOUND, code)
    }
    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, codes::INTERNAL)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ErrorBody {
            error: ErrorPayload {
                code: self.code.to_owned(),
                details: self.details,
            },
        };
        (self.status, Json(body)).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        // Details go to the log only; clients get a generic code.
        tracing::error!(%error, "database error");
        ApiError::internal()
    }
}

/// Stable codes for binary ("file") documents. They live here rather than in `mdr_domain::codes`
/// because only the server emits them; clients mirror them in their i18n catalogs.
pub mod file_codes {
    /// Text API (`GET /documents/{id}`, `PUT …/content`) on a file document.
    pub const NOT_TEXT: &str = "document.not_text";
    /// `GET /documents/{id}/file` on a text document.
    pub const NOT_FILE: &str = "document.not_file";
    /// Uploaded bytes do not match the declared sha-256.
    pub const HASH_MISMATCH: &str = "file.hash_mismatch";
    /// MIME type not allowed, or bytes without the matching signature.
    pub const UNSUPPORTED: &str = "file.unsupported";
    /// Upload larger than `MAX_FILE_BYTES`.
    pub const TOO_LARGE: &str = "file.too_large";
}
