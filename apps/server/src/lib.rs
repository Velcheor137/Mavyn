//! Mavyn self-hosted API server.

pub mod auth;
pub mod config;
pub mod crypto;
pub mod error;
pub mod routes;
pub mod state;

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use error::ApiError;
use mdr_domain::codes;
use mdr_sync_protocol::PROTOCOL_VERSION;
use serde_json::json;
use state::AppState;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../infrastructure/migrations");

/// Content-Security-Policy for the web app. `wasm-unsafe-eval` is needed by Shiki's regex engine;
/// inline styles by KaTeX/Shiki output. No inline scripts, no third-party origins.
const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async fn health(State(state): State<AppState>) -> Response {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
    {
        Ok(_) => Json(json!({ "status": "ok", "protocol": PROTOCOL_VERSION })).into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "status": "degraded" })),
        )
            .into_response(),
    }
}

/// Rejects clients speaking an unsupported major sync protocol (header optional for plain API use).
async fn protocol_guard(request: Request, next: Next) -> Response {
    if let Some(version) = request.headers().get("x-sync-protocol") {
        if version.to_str().ok().and_then(|v| v.parse::<u32>().ok()) != Some(PROTOCOL_VERSION) {
            return ApiError::new(StatusCode::BAD_REQUEST, codes::PROTOCOL)
                .with_details(json!({ "supported": PROTOCOL_VERSION }))
                .into_response();
        }
    }
    next.run(request).await
}

pub fn app(state: AppState) -> Router {
    use routes::{auth, documents, libraries};
    let body_limit = state.config.max_document_bytes + 64 * 1024;

    let api = Router::new()
        .route("/health", get(health))
        .route("/setup", get(auth::setup_status).post(auth::setup))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/auth/sessions", get(auth::list_sessions))
        .route("/auth/sessions/{id}", delete(auth::revoke_session))
        .route("/users", post(auth::create_user))
        .route("/libraries", get(libraries::list).post(libraries::create))
        .route(
            "/libraries/{id}/members",
            get(libraries::members).put(libraries::put_member),
        )
        .route(
            "/libraries/{id}/members/{user_id}",
            delete(libraries::remove_member),
        )
        .route(
            "/libraries/{id}/documents",
            get(documents::list).post(documents::create),
        )
        .route("/libraries/{id}/changes", get(documents::changes))
        .route("/libraries/{id}/search", get(documents::search))
        .route(
            "/documents/{id}",
            get(documents::get).delete(documents::delete),
        )
        .route("/documents/{id}/content", put(documents::update_content))
        .route("/documents/{id}/revisions", get(documents::revisions))
        .fallback(|| async { ApiError::not_found(codes::ROUTE_NOT_FOUND) })
        .layer(middleware::from_fn(protocol_guard))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ));

    let mut router = Router::new().nest("/api/v1", api);
    if let Some(dist) = &state.config.web_dist {
        let index = format!("{dist}/index.html");
        router = router.fallback_service(ServeDir::new(dist).fallback(ServeFile::new(index)));
    }

    router
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CSP),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
