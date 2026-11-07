use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    /// e.g. `https://notes.example.com`; enables strict Origin checks for browser requests.
    pub public_origin: Option<String>,
    /// Built web app to serve at `/` (optional).
    pub web_dist: Option<String>,
    pub max_document_bytes: usize,
    pub session_ttl_days: i64,
    /// Secure cookies; disable only for plain-HTTP development.
    pub cookie_secure: bool,
    /// Trust `X-Forwarded-For` from a reverse proxy for rate limiting.
    pub trust_proxy: bool,
}

fn var(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn flag(name: &str, default: bool) -> bool {
    var(name).map_or(default, |v| matches!(v.as_str(), "1" | "true" | "yes"))
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            database_url: var("DATABASE_URL").ok_or("DATABASE_URL is required")?,
            bind_addr: var("BIND_ADDR").unwrap_or_else(|| "0.0.0.0:8080".into()),
            public_origin: var("PUBLIC_ORIGIN").map(|o| o.trim_end_matches('/').to_owned()),
            web_dist: var("WEB_DIST"),
            max_document_bytes: var("MAX_DOCUMENT_BYTES").and_then(|v| v.parse().ok()).unwrap_or(16 * 1024 * 1024),
            session_ttl_days: var("SESSION_TTL_DAYS").and_then(|v| v.parse().ok()).unwrap_or(30),
            cookie_secure: flag("COOKIE_SECURE", true),
            trust_proxy: flag("TRUST_PROXY", false),
        })
    }

    /// Configuration for tests.
    pub fn for_tests() -> Self {
        Self {
            database_url: String::new(),
            bind_addr: "127.0.0.1:0".into(),
            public_origin: Some("https://notes.example".into()),
            web_dist: None,
            max_document_bytes: 64 * 1024,
            session_ttl_days: 30,
            cookie_secure: true,
            trust_proxy: false,
        }
    }

    pub fn cookie_name(&self) -> &'static str {
        // `__Host-` prefix: browser enforces Secure, Path=/, no Domain.
        if self.cookie_secure {
            "__Host-mdr_session"
        } else {
            "mdr_session"
        }
    }
}
