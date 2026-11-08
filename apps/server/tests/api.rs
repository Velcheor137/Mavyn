//! API integration tests against a real PostgreSQL (`DATABASE_URL`); each test gets a fresh database.

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use mdr_server::config::Config;
use mdr_server::state::AppState;
use mdr_server::{app, crypto, routes};
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

struct Api {
    router: Router,
}

struct Reply {
    status: StatusCode,
    body: Value,
    headers: axum::http::HeaderMap,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }
}

impl Api {
    async fn new(pool: PgPool) -> Self {
        Self {
            router: app(AppState::new(pool, Config::for_tests())),
        }
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
        extra: &[(&str, &str)],
    ) -> Reply {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"));
        if let Some(token) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        let req = match body {
            Some(b) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .expect("request");
        let res = self.router.clone().oneshot(req).await.expect("response");
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.expect("body").to_bytes();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        Reply {
            status,
            body,
            headers,
        }
    }

    async fn get(&self, path: &str, token: &str) -> Reply {
        self.call(Method::GET, path, Some(token), None, &[]).await
    }

    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> Reply {
        self.call(Method::POST, path, token, Some(body), &[]).await
    }

    /// Runs setup and returns the admin's bearer token.
    async fn bootstrap(&self, pool: &PgPool) -> String {
        let setup_token = routes::auth::bootstrap_setup_token(pool)
            .await
            .expect("bootstrap")
            .expect("token");
        let r = self.post("/setup", None, json!({ "token": setup_token, "username": "admin", "password": "correct horse battery" })).await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.body);
        self.login("admin", "correct horse battery").await
    }

    async fn login(&self, username: &str, password: &str) -> String {
        let r = self
            .post(
                "/auth/login",
                None,
                json!({ "username": username, "password": password }),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        r.body["token"].as_str().expect("token").to_owned()
    }

    async fn create_user(&self, admin: &str, username: &str) -> String {
        let r = self
            .post(
                "/users",
                Some(admin),
                json!({ "username": username, "password": "another good passphrase" }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.body);
        self.login(username, "another good passphrase").await
    }

    async fn create_library(&self, token: &str, name: &str) -> String {
        let r = self
            .post("/libraries", Some(token), json!({ "name": name }))
            .await;
        assert_eq!(r.status, StatusCode::CREATED);
        r.body["id"].as_str().expect("id").to_owned()
    }

    async fn create_doc(&self, token: &str, library: &str, content: &str) -> Value {
        let r = self
            .post(
                &format!("/libraries/{library}/documents"),
                Some(token),
                json!({ "id": Uuid::now_v7(), "file_name": "note.md", "content": content }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.body);
        r.body
    }

    async fn put_content(
        &self,
        token: &str,
        doc: &str,
        base: &str,
        content: &str,
        key: Option<&str>,
    ) -> Reply {
        let body = json!({ "base_revision_id": base, "content": content, "content_hash": crypto::sha256_hex(content.as_bytes()) });
        let headers: Vec<(&str, &str)> = key
            .map(|k| vec![("idempotency-key", k)])
            .unwrap_or_default();
        self.call(
            Method::PUT,
            &format!("/documents/{doc}/content"),
            Some(token),
            Some(body),
            &headers,
        )
        .await
    }
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn health_and_security_headers(pool: PgPool) {
    let api = Api::new(pool).await;
    let r = api.call(Method::GET, "/health", None, None, &[]).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["status"], "ok");
    assert!(r.headers[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .expect("csp")
        .contains("frame-ancestors 'none'"));
    assert_eq!(r.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    let r = api.call(Method::GET, "/nope", None, None, &[]).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::NOT_FOUND, "request.not_found")
    );
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn setup_requires_token_and_runs_once(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let token = routes::auth::bootstrap_setup_token(&pool)
        .await
        .expect("bootstrap")
        .expect("token");
    assert_eq!(
        api.call(Method::GET, "/setup", None, None, &[]).await.body["needs_setup"],
        true
    );

    let r = api
        .post(
            "/setup",
            None,
            json!({ "token": "wrong", "username": "admin", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::FORBIDDEN, "setup.invalid_token")
    );
    let r = api
        .post(
            "/setup",
            None,
            json!({ "token": token, "username": "admin", "password": "short" }),
        )
        .await;
    assert_eq!(r.code(), "user.weak_password");
    let r = api
        .post(
            "/setup",
            None,
            json!({ "token": token, "username": "admin", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let r = api
        .post(
            "/setup",
            None,
            json!({ "token": token, "username": "admin2", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::CONFLICT, "setup.already_completed")
    );
    assert!(routes::auth::bootstrap_setup_token(&pool)
        .await
        .expect("bootstrap")
        .is_none());
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn login_sessions_and_revocation(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;

    let r = api
        .post(
            "/auth/login",
            None,
            json!({ "username": "ADMIN", "password": "wrong password!!" }),
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::UNAUTHORIZED, "auth.invalid_credentials")
    );
    let r = api
        .post(
            "/auth/login",
            None,
            json!({ "username": "ghost", "password": "wrong password!!" }),
        )
        .await;
    assert_eq!(r.code(), "auth.invalid_credentials");

    // Usernames are case-insensitive.
    let second = api.login("Admin", "correct horse battery").await;
    let sessions = api.get("/auth/sessions", &admin).await.body;
    assert_eq!(sessions.as_array().expect("array").len(), 2);
    let other = sessions
        .as_array()
        .expect("array")
        .iter()
        .find(|s| s["current"] == false)
        .expect("other session")["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let r = api
        .call(
            Method::DELETE,
            &format!("/auth/sessions/{other}"),
            Some(&admin),
            None,
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(
        api.get("/auth/me", &second).await.status,
        StatusCode::UNAUTHORIZED
    );

    assert_eq!(
        api.call(Method::POST, "/auth/logout", Some(&admin), None, &[])
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        api.get("/auth/me", &admin).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn login_is_rate_limited(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    api.bootstrap(&pool).await;
    let mut last = StatusCode::OK;
    for _ in 0..12 {
        last = api
            .post(
                "/auth/login",
                None,
                json!({ "username": "victim", "password": "guess guess guess" }),
            )
            .await
            .status;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn cookie_auth_requires_csrf_and_origin(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let token = api.bootstrap(&pool).await;
    let csrf: String = sqlx::query_scalar("SELECT csrf_token FROM sessions WHERE token_hash = $1")
        .bind(crypto::sha256(token.as_bytes()))
        .fetch_one(&pool)
        .await
        .expect("csrf");
    let cookie = format!("__Host-mdr_session={token}");
    let body = Some(json!({ "name": "Lib" }));

    let r = api
        .call(Method::GET, "/auth/me", None, None, &[("cookie", &cookie)])
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["csrf_token"], csrf.as_str());
    let r = api
        .call(
            Method::POST,
            "/libraries",
            None,
            body.clone(),
            &[("cookie", &cookie)],
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::FORBIDDEN, "auth.csrf_failed")
    );
    let r = api
        .call(
            Method::POST,
            "/libraries",
            None,
            body.clone(),
            &[
                ("cookie", &cookie),
                ("x-csrf-token", &csrf),
                ("origin", "https://evil.example"),
            ],
        )
        .await;
    assert_eq!(r.code(), "auth.csrf_failed");
    let r = api
        .call(
            Method::POST,
            "/libraries",
            None,
            body,
            &[
                ("cookie", &cookie),
                ("x-csrf-token", &csrf),
                ("origin", "https://notes.example"),
            ],
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn library_acl_prevents_idor_and_enforces_roles(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let bob = api.create_user(&admin, "bob").await;
    let lib = api.create_library(&admin, "Private").await;
    let doc = api.create_doc(&admin, &lib, "# Secret\n").await;
    let doc_id = doc["id"].as_str().expect("id");

    // Non-members cannot discover the library or its documents.
    assert_eq!(
        api.get(&format!("/libraries/{lib}/documents"), &bob)
            .await
            .code(),
        "library.not_found"
    );
    assert_eq!(
        api.get(&format!("/documents/{doc_id}"), &bob).await.code(),
        "document.not_found"
    );
    assert!(api
        .get("/libraries", &bob)
        .await
        .body
        .as_array()
        .expect("array")
        .is_empty());

    // Viewer: read yes, write no.
    let r = api
        .call(
            Method::PUT,
            &format!("/libraries/{lib}/members"),
            Some(&admin),
            Some(json!({ "username": "BOB", "role": "viewer" })),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(
        api.get(&format!("/documents/{doc_id}"), &bob).await.body["content"],
        "# Secret\n"
    );
    let base = doc["head_revision_id"].as_str().expect("head");
    assert_eq!(
        api.put_content(&bob, doc_id, base, "hacked", None)
            .await
            .code(),
        "auth.forbidden"
    );
    // A viewer cannot grant roles.
    let r = api
        .call(
            Method::PUT,
            &format!("/libraries/{lib}/members"),
            Some(&bob),
            Some(json!({ "username": "bob", "role": "owner" })),
            &[],
        )
        .await;
    assert_eq!(r.code(), "auth.forbidden");

    // Editor: can write.
    api.call(
        Method::PUT,
        &format!("/libraries/{lib}/members"),
        Some(&admin),
        Some(json!({ "username": "bob", "role": "editor" })),
        &[],
    )
    .await;
    assert_eq!(
        api.put_content(&bob, doc_id, base, "# Secret\n\nedited", None)
            .await
            .status,
        StatusCode::OK
    );

    // The last owner cannot leave.
    let admin_id = api.get("/auth/me", &admin).await.body["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let r = api
        .call(
            Method::DELETE,
            &format!("/libraries/{lib}/members/{admin_id}"),
            Some(&admin),
            None,
            &[],
        )
        .await;
    assert_eq!(r.code(), "library.last_owner");
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn content_updates_are_compare_and_swap_and_idempotent(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let lib = api.create_library(&admin, "Notes").await;
    let doc = api.create_doc(&admin, &lib, "- [ ] a\n").await;
    let id = doc["id"].as_str().expect("id");
    let base = doc["head_revision_id"].as_str().expect("head").to_owned();

    let key = Uuid::now_v7().to_string();
    let first = api
        .put_content(&admin, id, &base, "- [x] a\n", Some(&key))
        .await;
    assert_eq!(first.status, StatusCode::OK);
    // Retrying the same operation returns the same result without a second revision.
    let retry = api
        .put_content(&admin, id, &base, "- [x] a\n", Some(&key))
        .await;
    assert_eq!(retry.status, StatusCode::OK);
    assert_eq!(
        retry.body["head_revision_id"],
        first.body["head_revision_id"]
    );
    assert_eq!(
        api.get(&format!("/documents/{id}/revisions"), &admin)
            .await
            .body
            .as_array()
            .expect("array")
            .len(),
        2
    );

    // A stale base is a conflict that reports the current head; nothing is overwritten.
    let stale = api
        .put_content(&admin, id, &base, "other device\n", None)
        .await;
    assert_eq!(
        (stale.status, stale.code()),
        (StatusCode::CONFLICT, "sync.conflict")
    );
    assert_eq!(
        stale.body["error"]["details"]["head_revision_id"],
        first.body["head_revision_id"]
    );
    assert_eq!(
        api.get(&format!("/documents/{id}"), &admin).await.body["content"],
        "- [x] a\n"
    );

    // Mismatched hash is rejected.
    let body = json!({ "base_revision_id": first.body["head_revision_id"], "content": "x", "content_hash": "00" });
    let r = api
        .call(
            Method::PUT,
            &format!("/documents/{id}/content"),
            Some(&admin),
            Some(body),
            &[],
        )
        .await;
    assert_eq!(r.code(), "request.invalid");

    // Oversized content is rejected (tests use a 64 KiB limit).
    let big = "a".repeat(70 * 1024);
    let r = api
        .put_content(
            &admin,
            id,
            first.body["head_revision_id"].as_str().expect("head"),
            &big,
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn change_feed_pages_and_reports_tombstones(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let lib = api.create_library(&admin, "Feed").await;
    let mut ids = Vec::new();
    for i in 0..3 {
        ids.push(
            api.create_doc(&admin, &lib, &format!("# Doc {i}\n")).await["id"]
                .as_str()
                .expect("id")
                .to_owned(),
        );
    }
    let page = api
        .get(&format!("/libraries/{lib}/changes?limit=2"), &admin)
        .await
        .body;
    assert_eq!(page["documents"].as_array().expect("docs").len(), 2);
    assert_eq!(page["has_more"], true);
    let cursor = page["cursor"].as_str().expect("cursor").to_owned();
    let rest = api
        .get(&format!("/libraries/{lib}/changes?cursor={cursor}"), &admin)
        .await
        .body;
    assert_eq!(rest["documents"].as_array().expect("docs").len(), 1);
    let cursor = rest["cursor"].as_str().expect("cursor").to_owned();

    assert_eq!(
        api.call(
            Method::DELETE,
            &format!("/documents/{}", ids[0]),
            Some(&admin),
            None,
            &[]
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    let after = api
        .get(&format!("/libraries/{lib}/changes?cursor={cursor}"), &admin)
        .await
        .body;
    let docs = after["documents"].as_array().expect("docs");
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0]["id"], ids[0].as_str());
    assert!(docs[0]["deleted_at"].is_string());
    assert_eq!(
        api.get(&format!("/libraries/{lib}/changes?cursor=abc"), &admin)
            .await
            .code(),
        "request.invalid"
    );
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn search_handles_russian_english_and_hostile_input(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let lib = api.create_library(&admin, "Search").await;
    api.create_doc(&admin, &lib, "# Ёжик\n\nСписок задач на неделю")
        .await;
    api.create_doc(&admin, &lib, "# Groceries\n\nBuy MILK and bread")
        .await;

    let hits = |r: Reply| {
        r.body
            .as_array()
            .expect("array")
            .iter()
            .map(|h| h["title"].as_str().unwrap_or("").to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        hits(
            api.get(
                &format!("/libraries/{lib}/search?q=%D0%B5%D0%B6%D0%B8%D0%BA"),
                &admin
            )
            .await
        ),
        vec!["Ёжик"]
    ); // "ежик"
    assert_eq!(
        hits(
            api.get(
                &format!("/libraries/{lib}/search?q=%D0%B7%D0%B0%D0%B4%D0%B0%D1%87"),
                &admin
            )
            .await
        ),
        vec!["Ёжик"]
    ); // "задач" prefix
    assert_eq!(
        hits(
            api.get(&format!("/libraries/{lib}/search?q=milk"), &admin)
                .await
        ),
        vec!["Groceries"]
    );
    // tsquery operators are stripped rather than interpreted.
    let r = api
        .get(
            &format!("/libraries/{lib}/search?q=%27%29%20%7C%20%21%3A%2A"),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.body.as_array().expect("array").is_empty());
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn rejects_unsupported_protocol_and_path_tricks(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let r = api
        .call(
            Method::GET,
            "/libraries",
            Some(&admin),
            None,
            &[("x-sync-protocol", "99")],
        )
        .await;
    assert_eq!(r.code(), "sync.protocol_unsupported");
    let lib = api.create_library(&admin, "L").await;
    let r = api
        .post(
            &format!("/libraries/{lib}/documents"),
            Some(&admin),
            json!({ "id": Uuid::now_v7(), "file_name": "../../etc/passwd", "content": "x" }),
        )
        .await;
    assert_eq!(r.code(), "request.invalid");
    // Re-using an existing document id never overwrites it.
    let doc = api.create_doc(&admin, &lib, "original").await;
    let r = api
        .post(
            &format!("/libraries/{lib}/documents"),
            Some(&admin),
            json!({ "id": doc["id"], "file_name": "x.md", "content": "overwrite" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(
        api.get(
            &format!("/documents/{}", doc["id"].as_str().expect("id")),
            &admin
        )
        .await
        .body["content"],
        "original"
    );
}
