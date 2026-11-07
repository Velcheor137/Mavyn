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
        Self { status, code, details: Value::Null }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    pub fn bad_request(field: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, codes::BAD_REQUEST).with_details(json!({ "field": field }))
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
        let body = ErrorBody { error: ErrorPayload { code: self.code.to_owned(), details: self.details } };
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
