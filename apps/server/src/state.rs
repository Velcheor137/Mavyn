use crate::auth::RateLimiter;
use crate::config::Config;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub auth_limiter: Arc<RateLimiter>,
}

impl AppState {
    pub fn new(db: PgPool, config: Config) -> Self {
        Self {
            db,
            config: Arc::new(config),
            auth_limiter: Arc::new(RateLimiter::new(10, Duration::from_secs(300))),
        }
    }
}
