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

/// Percent-encodes everything except unreserved characters (enough for test query strings).
fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

const PDF: &str = "application/pdf";
const DOCX: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

fn pdf_bytes(len: usize) -> Vec<u8> {
    let mut bytes = b"%PDF-1.7\n% quarterly payroll\n".to_vec();
    bytes.resize(len.max(bytes.len()), b'x');
    bytes
}

struct Reply {
    status: StatusCode,
    body: Value,
    headers: axum::http::HeaderMap,
    raw: Vec<u8>,
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
        self.send(req).await
    }

    async fn send(&self, req: Request<Body>) -> Reply {
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
            raw: bytes.to_vec(),
        }
    }

    /// `POST /libraries/{library}/files` with a raw body. `sha256` defaults to the body's hash.
    #[allow(clippy::too_many_arguments)]
    async fn upload(
        &self,
        token: Option<&str>,
        library: &str,
        id: &str,
        file_name: &str,
        mime: &str,
        bytes: &[u8],
        sha256: Option<&str>,
        extra: &str,
    ) -> Reply {
        let hash = sha256.map_or_else(|| crypto::sha256_hex(bytes), str::to_owned);
        let uri = format!(
            "/api/v1/libraries/{library}/files?id={id}&file_name={}&sha256={hash}&mime={}{extra}",
            urlencode(file_name),
            urlencode(mime)
        );
        let mut req = Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/octet-stream");
        if let Some(token) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        self.send(req.body(Body::from(bytes.to_vec())).expect("request"))
            .await
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
    // Retrying the same operation returns the same result without a second update.
    let retry = api
        .put_content(&admin, id, &base, "- [x] a\n", Some(&key))
        .await;
    assert_eq!(retry.status, StatusCode::OK);
    assert_eq!(
        retry.body["head_revision_id"],
        first.body["head_revision_id"]
    );
    // No version history (ADR-008): the replaced text is gone and there is no history route.
    let first_hash = doc["content_hash"].as_str().expect("hash").to_owned();
    let blobs: i64 = sqlx::query_scalar("SELECT count(*) FROM blobs WHERE hash = $1")
        .bind(&first_hash)
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(blobs, 0);
    assert_eq!(
        api.get(&format!("/documents/{id}/revisions"), &admin)
            .await
            .code(),
        "request.not_found"
    );
    // Content shared by two documents survives when one of them changes.
    let one = api.create_doc(&admin, &lib, "shared\n").await;
    api.create_doc(&admin, &lib, "shared\n").await;
    let r = api
        .put_content(
            &admin,
            one["id"].as_str().expect("id"),
            one["head_revision_id"].as_str().expect("head"),
            "changed\n",
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let shared: i64 = sqlx::query_scalar("SELECT count(*) FROM blobs WHERE hash = $1")
        .bind(crypto::sha256_hex(b"shared\n"))
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(shared, 1);

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
    // Clients of protocol 1 (v0.1.x) treat files as immutable: refused, with the supported version.
    let r = api
        .call(
            Method::GET,
            "/libraries",
            Some(&admin),
            None,
            &[("x-sync-protocol", "1")],
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::BAD_REQUEST, "sync.protocol_unsupported")
    );
    assert_eq!(r.body["error"]["details"]["supported"], 2);
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

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn folders_sync_names_locations_and_deletions(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let lib = api.create_library(&admin, "Tree").await;
    let patch = |path: String, body: Value| {
        let api = &api;
        let admin = admin.clone();
        async move {
            api.call(Method::PATCH, &path, Some(&admin), Some(body), &[])
                .await
        }
    };
    let folder = |name: &str, parent: Option<&str>| json!({ "id": Uuid::now_v7(), "name": name, "parent_id": parent });

    // Create, retry, and a second device creating the same name: one folder.
    let work_req = folder("Работа", None);
    let work = api
        .post(
            &format!("/libraries/{lib}/folders"),
            Some(&admin),
            work_req.clone(),
        )
        .await;
    assert_eq!(work.status, StatusCode::CREATED, "{:?}", work.body);
    let work_id = work.body["id"].as_str().expect("id").to_owned();
    let retry = api
        .post(&format!("/libraries/{lib}/folders"), Some(&admin), work_req)
        .await;
    assert_eq!(
        (retry.status, retry.body["id"].as_str()),
        (StatusCode::OK, Some(work_id.as_str()))
    );
    let twin = api
        .post(
            &format!("/libraries/{lib}/folders"),
            Some(&admin),
            folder("работа", None),
        )
        .await;
    assert_eq!(
        (twin.status, twin.body["id"].as_str()),
        (StatusCode::OK, Some(work_id.as_str()))
    );
    let plans = api
        .post(
            &format!("/libraries/{lib}/folders"),
            Some(&admin),
            folder("Plans", Some(&work_id)),
        )
        .await;
    let plans_id = plans.body["id"].as_str().expect("id").to_owned();

    // Documents can be created in a folder, renamed and moved with compare-and-swap per field.
    let doc_id = Uuid::now_v7().to_string();
    let r = api.post(&format!("/libraries/{lib}/documents"), Some(&admin), json!({ "id": doc_id, "file_name": "draft.md", "content": "no heading", "folder_id": plans_id })).await;
    assert_eq!(r.body["folder_id"], plans_id.as_str());
    let r = patch(format!("/documents/{doc_id}"), json!({ "base_file_name": "draft.md", "base_folder_id": plans_id, "file_name": "final.md", "folder_id": work_id })).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(
        (
            r.body["file_name"].as_str(),
            r.body["folder_id"].as_str(),
            r.body["title"].as_str()
        ),
        (Some("final.md"), Some(work_id.as_str()), Some("final"))
    );
    // A stale base leaves that field as the server has it.
    let r = patch(format!("/documents/{doc_id}"), json!({ "base_file_name": "draft.md", "base_folder_id": plans_id, "file_name": "other.md", "folder_id": null })).await;
    assert_eq!(
        (r.body["file_name"].as_str(), r.body["folder_id"].as_str()),
        (Some("final.md"), Some(work_id.as_str()))
    );

    // Moving a folder below its own descendant is ignored.
    let r = patch(format!("/folders/{work_id}"), json!({ "base_name": "Работа", "base_parent_id": null, "name": "Work", "parent_id": plans_id })).await;
    assert_eq!(
        (r.body["name"].as_str(), r.body["parent_id"].is_null()),
        (Some("Work"), true)
    );

    // The feed reports folders and documents from one cursor.
    let feed = api
        .get(&format!("/libraries/{lib}/changes"), &admin)
        .await
        .body;
    assert_eq!(feed["folders"].as_array().expect("folders").len(), 2);
    assert_eq!(feed["documents"].as_array().expect("docs").len(), 1);
    let cursor = feed["cursor"].as_str().expect("cursor").to_owned();
    let page = api
        .get(&format!("/libraries/{lib}/changes?limit=1"), &admin)
        .await
        .body;
    assert_eq!(page["has_more"], true);
    assert_eq!(
        page["folders"].as_array().expect("folders").len()
            + page["documents"].as_array().expect("docs").len(),
        1
    );

    // Deleting a folder deletes its subtree and the documents in it.
    let r = api
        .call(
            Method::DELETE,
            &format!("/folders/{work_id}"),
            Some(&admin),
            None,
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let after = api
        .get(&format!("/libraries/{lib}/changes?cursor={cursor}"), &admin)
        .await
        .body;
    let folders = after["folders"].as_array().expect("folders");
    assert_eq!(folders.len(), 2);
    assert!(folders.iter().all(|f| f["deleted_at"].is_string()));
    assert!(after["documents"][0]["deleted_at"].is_string());

    // Folders of other libraries are invisible.
    let other = api.create_user(&admin, "other").await;
    let r = api.call(Method::PATCH, &format!("/folders/{plans_id}"), Some(&other), Some(json!({ "base_name": "Plans", "base_parent_id": null, "name": "x", "parent_id": null })), &[]).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::NOT_FOUND, "folder.not_found")
    );
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn files_upload_download_and_validation(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let lib = api.create_library(&admin, "Docs").await;
    let folder_id = Uuid::now_v7().to_string();
    let r = api
        .post(
            &format!("/libraries/{lib}/folders"),
            Some(&admin),
            json!({ "id": folder_id, "parent_id": null, "name": "Отчёты" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.body);

    // Upload into a folder; the title is the file name without its extension.
    let bytes = pdf_bytes(2000);
    let id = Uuid::now_v7().to_string();
    let extra = format!("&folder_id={folder_id}");
    let r = api
        .upload(
            Some(&admin),
            &lib,
            &id,
            "Отчёт за квартал.pdf",
            PDF,
            &bytes,
            None,
            &extra,
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.body);
    let hash = crypto::sha256_hex(&bytes);
    assert_eq!(r.body["id"], id.as_str());
    assert_eq!(r.body["kind"], "file");
    assert_eq!(r.body["mime"], PDF);
    assert_eq!(r.body["title"], "Отчёт за квартал");
    assert_eq!(r.body["file_name"], "Отчёт за квартал.pdf");
    assert_eq!(r.body["folder_id"], folder_id.as_str());
    assert_eq!(r.body["content_hash"], hash.as_str());

    // Download: the same bytes, never typed as something a browser would render.
    let r = api.get(&format!("/documents/{id}/file"), &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.raw, bytes);
    assert_eq!(r.headers[header::CONTENT_TYPE], "application/octet-stream");
    assert_eq!(r.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(r.headers[header::CONTENT_LENGTH], bytes.len().to_string());

    // Idempotent retry returns the stored response; reusing the id without a key is a conflict.
    let key = Uuid::now_v7().to_string();
    let other_id = Uuid::now_v7().to_string();
    let docx = b"PK\x03\x04 fake docx".to_vec();
    let upload_with_key = |key: String| {
        let api = &api;
        let (admin, lib, other_id, docx) =
            (admin.clone(), lib.clone(), other_id.clone(), docx.clone());
        async move {
            let hash = crypto::sha256_hex(&docx);
            let uri = format!(
                "/api/v1/libraries/{lib}/files?id={other_id}&file_name=a.docx&sha256={hash}&mime={}",
                urlencode(DOCX)
            );
            let req = Request::builder()
                .method(Method::POST)
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {admin}"))
                .header("idempotency-key", key)
                .body(Body::from(docx))
                .expect("request");
            api.send(req).await
        }
    };
    let first = upload_with_key(key.clone()).await;
    assert_eq!(first.status, StatusCode::CREATED, "{:?}", first.body);
    assert_eq!(first.body["mime"], DOCX);
    let retry = upload_with_key(key).await;
    assert_eq!(
        (retry.status, &retry.body),
        (StatusCode::CREATED, &first.body)
    );
    let r = api
        .upload(Some(&admin), &lib, &id, "again.pdf", PDF, &bytes, None, "")
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::CONFLICT, "sync.conflict")
    );

    // Declared hash must match the body.
    let wrong = crypto::sha256_hex(b"something else");
    let r = api
        .upload(
            Some(&admin),
            &lib,
            &Uuid::now_v7().to_string(),
            "x.pdf",
            PDF,
            &bytes,
            Some(&wrong),
            "",
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::BAD_REQUEST, "file.hash_mismatch")
    );

    // Signature must match the declared type, and the type must be on the allow-list.
    for (mime, body) in [
        (DOCX, bytes.clone()),
        (PDF, b"PK\x03\x04 zip, not pdf".to_vec()),
        ("text/html", b"<script>alert(1)</script>".to_vec()),
    ] {
        let r = api
            .upload(
                Some(&admin),
                &lib,
                &Uuid::now_v7().to_string(),
                "x.pdf",
                mime,
                &body,
                None,
                "",
            )
            .await;
        assert_eq!(
            (r.status, r.code()),
            (StatusCode::UNSUPPORTED_MEDIA_TYPE, "file.unsupported"),
            "{mime}"
        );
    }

    // The route's own limit (`MAX_FILE_BYTES`, 256 KiB in tests) applies, not the smaller global
    // body limit for text documents.
    let max = Config::for_tests().max_file_bytes;
    let r = api
        .upload(
            Some(&admin),
            &lib,
            &Uuid::now_v7().to_string(),
            "big.pdf",
            PDF,
            &pdf_bytes(max),
            None,
            "",
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.body);
    let r = api
        .upload(
            Some(&admin),
            &lib,
            &Uuid::now_v7().to_string(),
            "huge.pdf",
            PDF,
            &pdf_bytes(max + 1),
            None,
            "",
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::PAYLOAD_TOO_LARGE, "file.too_large")
    );
    assert_eq!(r.body["error"]["details"]["max_bytes"], max);
    // Text documents keep their own (smaller) limit.
    let r = api
        .post(
            &format!("/libraries/{lib}/documents"),
            Some(&admin),
            json!({ "id": Uuid::now_v7(), "file_name": "big.md", "content": "x".repeat(max) }),
        )
        .await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);

    // Malformed query parameters are a stable `request.invalid`.
    let r = api
        .upload(
            Some(&admin),
            &lib,
            "not-a-uuid",
            "x.pdf",
            PDF,
            &bytes,
            None,
            "",
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::BAD_REQUEST, "request.invalid")
    );
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn file_documents_are_not_text(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let lib = api.create_library(&admin, "Docs").await;
    let id = Uuid::now_v7().to_string();
    let bytes = pdf_bytes(100);
    let file = api
        .upload(Some(&admin), &lib, &id, "scan.pdf", PDF, &bytes, None, "")
        .await;
    assert_eq!(file.status, StatusCode::CREATED, "{:?}", file.body);
    let head = file.body["head_revision_id"]
        .as_str()
        .expect("head")
        .to_owned();

    let r = api.get(&format!("/documents/{id}"), &admin).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::CONFLICT, "document.not_text")
    );
    let r = api.put_content(&admin, &id, &head, "text", None).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::CONFLICT, "document.not_text")
    );

    let text = api.create_doc(&admin, &lib, "# Note\n").await;
    assert_eq!(text["kind"], "text");
    assert!(text["mime"].is_null());
    let text_id = text["id"].as_str().expect("id");
    let r = api.get(&format!("/documents/{text_id}/file"), &admin).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::CONFLICT, "document.not_file")
    );
    let r = api.get(&format!("/documents/{text_id}"), &admin).await;
    assert_eq!(
        (r.body["kind"].as_str(), r.body["content"].as_str()),
        (Some("text"), Some("# Note\n"))
    );

    // Rename: title follows the new file name; bytes and history are untouched.
    let r = api
        .call(
            Method::PATCH,
            &format!("/documents/{id}"),
            Some(&admin),
            Some(json!({ "base_file_name": "scan.pdf", "base_folder_id": null, "file_name": "Договор аренды.pdf", "folder_id": null })),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.body["title"], "Договор аренды");
    assert_eq!(r.body["kind"], "file");
    assert_eq!(r.body["mime"], PDF);
    assert_eq!(r.body["head_revision_id"], head.as_str());
    let r = api.get(&format!("/documents/{id}/file"), &admin).await;
    assert_eq!(r.raw, bytes);
    let r = api
        .get(&format!("/libraries/{lib}/search?q=аренды"), &admin)
        .await;
    assert_eq!(r.body[0]["document_id"], id.as_str());

    // Soft delete works like for text documents.
    let r = api
        .call(
            Method::DELETE,
            &format!("/documents/{id}"),
            Some(&admin),
            None,
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let feed = api.get(&format!("/libraries/{lib}/changes"), &admin).await;
    let docs = feed.body["documents"].as_array().expect("docs");
    assert!(docs
        .iter()
        .any(|d| d["id"] == id.as_str() && d["deleted_at"].is_string()));
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn files_appear_in_changes_and_are_searched_by_title(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let lib = api.create_library(&admin, "Mixed").await;
    let text = api.create_doc(&admin, &lib, "# Квартал\nтекст\n").await;
    let file_id = Uuid::now_v7().to_string();
    let r = api
        .upload(
            Some(&admin),
            &lib,
            &file_id,
            "Квартальный отчёт.pdf",
            PDF,
            &pdf_bytes(100),
            None,
            "",
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.body);

    let feed = api.get(&format!("/libraries/{lib}/changes"), &admin).await;
    let docs = feed.body["documents"].as_array().expect("docs");
    assert_eq!(docs.len(), 2);
    let text_info = docs.iter().find(|d| d["id"] == text["id"]).expect("text");
    assert_eq!(text_info["kind"], "text");
    assert!(text_info["mime"].is_null() && text_info["original_hash"].is_null());
    let file = docs
        .iter()
        .find(|d| d["id"] == file_id.as_str())
        .expect("file in feed");
    assert_eq!(
        (file["kind"].as_str(), file["mime"].as_str()),
        (Some("file"), Some(PDF))
    );
    assert_eq!(file["original_hash"], file["content_hash"]);

    // Search finds files by title only (the bytes contain "payroll").
    let hits = api
        .get(&format!("/libraries/{lib}/search?q=квартал"), &admin)
        .await;
    let hits = hits.body.as_array().expect("hits").clone();
    assert_eq!(hits.len(), 2);
    let hit = hits
        .iter()
        .find(|h| h["document_id"] == file_id.as_str())
        .expect("file hit");
    assert_eq!(hit["title"], "Квартальный отчёт");
    assert!(hit["snippet"].as_str().expect("snippet").contains('⟦'));
    let hits = api
        .get(&format!("/libraries/{lib}/search?q=payroll"), &admin)
        .await;
    assert!(hits.body.as_array().expect("hits").is_empty());
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn files_are_replaced_with_compare_and_swap_and_keep_their_original(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let bob = api.create_user(&admin, "bob").await;
    let lib = api.create_library(&admin, "Edits").await;
    let id = Uuid::now_v7().to_string();
    let v1 = b"PK\x03\x04 docx v1".to_vec();
    let r = api
        .upload(Some(&admin), &lib, &id, "plan.docx", DOCX, &v1, None, "")
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.body);
    let head1 = r.body["head_revision_id"]
        .as_str()
        .expect("head")
        .to_owned();
    let replace = |token: String, base: String, bytes: Vec<u8>, key: Option<String>| {
        let api = &api;
        let id = id.clone();
        async move {
            let hash = crypto::sha256_hex(&bytes);
            let mut req = Request::builder()
                .method(Method::PUT)
                .uri(format!(
                    "/api/v1/documents/{id}/file?base_revision_id={base}&sha256={hash}"
                ))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/octet-stream");
            if let Some(key) = key {
                req = req.header("idempotency-key", key);
            }
            api.send(req.body(Body::from(bytes)).expect("request"))
                .await
        }
    };

    let v2 = b"PK\x03\x04 docx v2".to_vec();
    let key = Uuid::now_v7().to_string();
    let r = replace(admin.clone(), head1.clone(), v2.clone(), Some(key.clone())).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.body["content_hash"], crypto::sha256_hex(&v2).as_str());
    assert_eq!(r.body["original_hash"], crypto::sha256_hex(&v1).as_str());
    let head2 = r.body["head_revision_id"]
        .as_str()
        .expect("head")
        .to_owned();
    assert_ne!(head1, head2);
    // Idempotent retry.
    let retry = replace(admin.clone(), head1.clone(), v2.clone(), Some(key)).await;
    assert_eq!(retry.body["head_revision_id"], head2.as_str());
    assert_eq!(
        api.get(&format!("/documents/{id}/file"), &admin).await.raw,
        v2
    );
    assert_eq!(
        api.get(&format!("/documents/{id}/original"), &admin)
            .await
            .raw,
        v1
    );

    // A stale base is a conflict; nothing is overwritten.
    let r = replace(
        admin.clone(),
        head1.clone(),
        b"PK\x03\x04 other".to_vec(),
        None,
    )
    .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::CONFLICT, "sync.conflict")
    );
    assert_eq!(
        r.body["error"]["details"]["head_revision_id"],
        head2.as_str()
    );
    // Wrong signature for the document's type, wrong hash.
    let r = replace(admin.clone(), head2.clone(), b"%PDF-1.7".to_vec(), None).await;
    assert_eq!(r.code(), "file.unsupported");
    let r = api
        .send(
            Request::builder()
                .method(Method::PUT)
                .uri(format!(
                    "/api/v1/documents/{id}/file?base_revision_id={head2}&sha256={}",
                    "0".repeat(64)
                ))
                .header(header::AUTHORIZATION, format!("Bearer {admin}"))
                .body(Body::from(v2.clone()))
                .expect("request"),
        )
        .await;
    assert_eq!(r.code(), "file.hash_mismatch");

    // v2 replaced by v3: v2's blob goes (no history), the original stays.
    let v3 = b"PK\x03\x04 docx v3".to_vec();
    let r = replace(admin.clone(), head2.clone(), v3.clone(), None).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let count = |hash: String| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM file_blobs WHERE hash = $1")
                .bind(hash)
                .fetch_one(&pool)
                .await
                .expect("count")
        }
    };
    assert_eq!(count(crypto::sha256_hex(&v2)).await, 0);
    assert_eq!(count(crypto::sha256_hex(&v1)).await, 1);

    // Authorization: a non-member cannot see it, a viewer cannot write; text documents refuse.
    let head3 = r.body["head_revision_id"]
        .as_str()
        .expect("head")
        .to_owned();
    let r = replace(bob.clone(), head3.clone(), v1.clone(), None).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::NOT_FOUND, "document.not_found")
    );
    assert_eq!(
        api.get(&format!("/documents/{id}/original"), &bob)
            .await
            .code(),
        "document.not_found"
    );
    api.call(
        Method::PUT,
        &format!("/libraries/{lib}/members"),
        Some(&admin),
        Some(json!({ "username": "bob", "role": "viewer" })),
        &[],
    )
    .await;
    let r = replace(bob.clone(), head3.clone(), v1.clone(), None).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::FORBIDDEN, "auth.forbidden")
    );
    let text = api.create_doc(&admin, &lib, "# t\n").await;
    let text_id = text["id"].as_str().expect("id");
    assert_eq!(
        api.get(&format!("/documents/{text_id}/original"), &admin)
            .await
            .code(),
        "document.not_file"
    );
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn file_routes_enforce_library_acl(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let bob = api.create_user(&admin, "bob").await;
    let lib = api.create_library(&admin, "Private").await;
    let bob_lib = api.create_library(&bob, "Bob's").await;
    let id = Uuid::now_v7().to_string();
    let bytes = pdf_bytes(100);
    let r = api
        .upload(Some(&admin), &lib, &id, "secret.pdf", PDF, &bytes, None, "")
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.body);

    // Anonymous: 401 on both routes.
    let r = api
        .upload(
            None,
            &lib,
            &Uuid::now_v7().to_string(),
            "a.pdf",
            PDF,
            &bytes,
            None,
            "",
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = api
        .call(
            Method::GET,
            &format!("/documents/{id}/file"),
            None,
            None,
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // Non-member: the library and its files do not exist.
    let r = api
        .upload(
            Some(&bob),
            &lib,
            &Uuid::now_v7().to_string(),
            "a.pdf",
            PDF,
            &bytes,
            None,
            "",
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::NOT_FOUND, "library.not_found")
    );
    let r = api.get(&format!("/documents/{id}/file"), &bob).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::NOT_FOUND, "document.not_found")
    );
    assert!(r.raw.is_empty() || !r.raw.starts_with(b"%PDF"));
    // Reusing someone else's document id in one's own library never overwrites it.
    let r = api
        .upload(
            Some(&bob),
            &bob_lib,
            &id,
            "mine.pdf",
            PDF,
            &pdf_bytes(50),
            None,
            "",
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::CONFLICT, "sync.conflict")
    );
    let r = api.get(&format!("/documents/{id}/file"), &admin).await;
    assert_eq!(r.raw, bytes);

    // Viewer: download yes, upload no.
    let r = api
        .call(
            Method::PUT,
            &format!("/libraries/{lib}/members"),
            Some(&admin),
            Some(json!({ "username": "bob", "role": "viewer" })),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = api.get(&format!("/documents/{id}/file"), &bob).await;
    assert_eq!(
        (r.status, r.raw.as_slice()),
        (StatusCode::OK, bytes.as_slice())
    );
    let r = api
        .upload(
            Some(&bob),
            &lib,
            &Uuid::now_v7().to_string(),
            "a.pdf",
            PDF,
            &bytes,
            None,
            "",
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::FORBIDDEN, "auth.forbidden")
    );
}

/// `content_hash` lost its foreign key in 0003 (it points into `blobs` or `file_blobs` by kind);
/// the replacement triggers must still reject dangling or cross-kind hashes.
#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn content_hash_must_reference_a_blob_of_the_right_kind(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let lib = api.create_library(&admin, "Integrity").await;
    let text = api.create_doc(&admin, &lib, "# A\n").await;
    let text_id = Uuid::parse_str(text["id"].as_str().expect("id")).expect("uuid");
    let file_id = Uuid::now_v7();
    let r = api
        .upload(
            Some(&admin),
            &lib,
            &file_id.to_string(),
            "a.pdf",
            PDF,
            &pdf_bytes(10),
            None,
            "",
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.body);
    let file_hash = r.body["content_hash"].as_str().expect("hash").to_owned();
    let text_hash = text["content_hash"].as_str().expect("hash").to_owned();

    let dangling = "0".repeat(64);
    for (doc, hash) in [
        (text_id, &dangling),
        (text_id, &file_hash),
        (file_id, &text_hash),
    ] {
        let doc_update = sqlx::query("UPDATE documents SET content_hash = $2 WHERE id = $1")
            .bind(doc)
            .bind(hash)
            .execute(&pool)
            .await;
        assert!(doc_update.is_err(), "document {doc} accepted {hash}");
    }
    // `kind` and `mime` stay consistent.
    let r = sqlx::query("UPDATE documents SET mime = NULL WHERE id = $1")
        .bind(file_id)
        .execute(&pool)
        .await;
    assert!(r.is_err());
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn text_files_keep_their_encoding_and_are_titled_by_name(pool: PgPool) {
    let api = Api::new(pool.clone()).await;
    let admin = api.bootstrap(&pool).await;
    let lib = api.create_library(&admin, "Code").await;
    let id = Uuid::now_v7();
    let r = api
        .post(
            &format!("/libraries/{lib}/documents"),
            Some(&admin),
            json!({ "id": id, "file_name": "main.py", "content": "# comment\nprint(1)\n", "encoding": "Windows-1251" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.body);
    // Code is titled by its file name: `#` lines are comments, not headings.
    assert_eq!(r.body["title"], "main.py");
    assert_eq!(r.body["encoding"], "windows-1251");
    assert_eq!(r.body["kind"], "text");
    let got = api.get(&format!("/documents/{id}"), &admin).await;
    assert_eq!(got.body["encoding"], "windows-1251");

    // Encoding is compare-and-swapped like the name; a stale base leaves it as the server has it.
    let patch = |body: Value| {
        let api = &api;
        let admin = admin.clone();
        async move {
            api.call(
                Method::PATCH,
                &format!("/documents/{id}"),
                Some(&admin),
                Some(body),
                &[],
            )
            .await
        }
    };
    let r = patch(json!({ "base_file_name": "main.py", "base_folder_id": null, "file_name": "main.py", "folder_id": null, "base_encoding": "koi8-r", "encoding": "utf-8" })).await;
    assert_eq!(r.body["encoding"], "windows-1251");
    let r = patch(json!({ "base_file_name": "main.py", "base_folder_id": null, "file_name": "main.py", "folder_id": null, "base_encoding": "windows-1251", "encoding": "utf-8" })).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert!(r.body["encoding"].is_null());
    let r = patch(json!({ "base_file_name": "main.py", "base_folder_id": null, "file_name": "notes.md", "folder_id": null })).await;
    // Renamed to Markdown: the first heading becomes the title.
    assert_eq!(r.body["title"], "comment");
    let r = api
        .post(
            &format!("/libraries/{lib}/documents"),
            Some(&admin),
            json!({ "id": Uuid::now_v7(), "file_name": "a.txt", "content": "x", "encoding": "not an encoding" }),
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::BAD_REQUEST, "request.invalid")
    );
}
