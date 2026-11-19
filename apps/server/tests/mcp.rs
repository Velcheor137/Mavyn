//! MCP endpoint (`/mcp`) against a real PostgreSQL (`DATABASE_URL`); each test gets a fresh database.

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use base64::Engine;
use http_body_util::BodyExt;
use mdr_server::config::Config;
use mdr_server::state::AppState;
use mdr_server::{app, crypto, routes};
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

const PROTOCOL: &str = "2025-11-25";

struct Harness {
    router: Router,
}

struct Reply {
    status: StatusCode,
    body: Value,
    headers: axum::http::HeaderMap,
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../tests/fixtures/files/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .expect("fixture")
}

impl Harness {
    fn new(pool: PgPool) -> Self {
        Self {
            router: app(AppState::new(pool, Config::for_tests())),
        }
    }

    async fn send(&self, req: Request<Body>) -> Reply {
        let res = self.router.clone().oneshot(req).await.expect("response");
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.expect("body").to_bytes();
        Reply {
            status,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            headers,
        }
    }

    async fn api(&self, method: Method, path: &str, token: &str, body: Option<Value>) -> Reply {
        let req = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json");
        self.send(
            req.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
                .expect("request"),
        )
        .await
    }

    async fn admin(&self, pool: &PgPool) -> String {
        let setup = routes::auth::bootstrap_setup_token(pool)
            .await
            .expect("bootstrap")
            .expect("token");
        let r = self
            .api(Method::POST, "/setup", "", Some(json!({ "token": setup, "username": "admin", "password": "correct horse battery" })))
            .await;
        assert_eq!(r.status, StatusCode::CREATED);
        let r = self
            .api(
                Method::POST,
                "/auth/login",
                "",
                Some(json!({ "username": "admin", "password": "correct horse battery" })),
            )
            .await;
        r.body["token"].as_str().expect("token").to_owned()
    }

    async fn key(&self, admin: &str, access: &str, can_delete: bool) -> String {
        let r = self
            .api(Method::POST, "/tokens", admin, Some(json!({ "name": "mcp", "access": access, "can_delete": can_delete, "all_libraries": true, "expires_in_days": 30 })))
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.body);
        r.body["token"].as_str().expect("key").to_owned()
    }

    async fn rpc_raw(&self, key: Option<&str>, origin: Option<&str>, body: Value) -> Reply {
        let mut req = Request::builder()
            .method(Method::POST)
            .uri("/mcp")
            .header(header::HOST, "notes.example")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header("mcp-protocol-version", PROTOCOL);
        if let Some(key) = key {
            req = req.header(header::AUTHORIZATION, format!("Bearer {key}"));
        }
        if let Some(origin) = origin {
            req = req.header(header::ORIGIN, origin);
        }
        self.send(req.body(Body::from(body.to_string())).expect("request"))
            .await
    }

    async fn rpc(&self, key: &str, method: &str, params: Value) -> Value {
        let r = self
            .rpc_raw(
                Some(key),
                None,
                json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{method}: {:?}", r.body);
        assert!(r.body["error"].is_null(), "{method}: {:?}", r.body);
        r.body["result"].clone()
    }

    async fn tool(&self, key: &str, name: &str, arguments: Value) -> (bool, Vec<String>, Value) {
        let result = self
            .rpc(
                key,
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await;
        let texts = result["content"]
            .as_array()
            .expect("content")
            .iter()
            .filter_map(|c| c["text"].as_str().map(str::to_owned))
            .collect();
        (result["isError"] == true, texts, result)
    }

    async fn tool_json(&self, key: &str, name: &str, arguments: Value) -> Value {
        let (error, texts, _) = self.tool(key, name, arguments).await;
        assert!(!error, "{name}: {texts:?}");
        serde_json::from_str(&texts[0]).expect("json")
    }
}

fn tool_names(result: &Value) -> Vec<String> {
    let mut names: Vec<String> = result["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|t| t["name"].as_str().expect("name").to_owned())
        .collect();
    names.sort();
    names
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn mcp_requires_an_api_key_and_a_trusted_origin(pool: PgPool) {
    let h = Harness::new(pool.clone());
    let admin = h.admin(&pool).await;
    let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } } });

    let r = h.rpc_raw(None, None, init.clone()).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        r.headers[header::WWW_AUTHENTICATE],
        "Bearer realm=\"Mavyn\""
    );
    // A sign-in session is not an API key.
    let r = h.rpc_raw(Some(&admin), None, init.clone()).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let fake = format!("mvn_{}", crypto::random_token());
    assert_eq!(
        h.rpc_raw(Some(&fake), None, init.clone()).await.status,
        StatusCode::UNAUTHORIZED
    );

    let key = h.key(&admin, "read", false).await;
    let r = h
        .rpc_raw(Some(&key), Some("https://evil.example"), init.clone())
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = h
        .rpc_raw(Some(&key), Some("https://notes.example"), init.clone())
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.body["result"]["serverInfo"]["name"], "mavyn");
    assert!(r.body["result"]["capabilities"]["tools"].is_object());
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn mcp_tools_follow_the_key_permissions(pool: PgPool) {
    let h = Harness::new(pool.clone());
    let admin = h.admin(&pool).await;
    let read = h.key(&admin, "read", false).await;
    let write = h.key(&admin, "write", false).await;
    let delete = h.key(&admin, "write", true).await;

    let names = tool_names(&h.rpc(&read, "tools/list", json!({})).await);
    assert_eq!(
        names,
        [
            "download_file",
            "list_documents",
            "list_libraries",
            "read_document",
            "search"
        ]
    );
    let names = tool_names(&h.rpc(&write, "tools/list", json!({})).await);
    assert!(
        names.contains(&"update_document".to_owned())
            && !names.contains(&"delete_document".to_owned())
    );
    let names = tool_names(&h.rpc(&delete, "tools/list", json!({})).await);
    assert!(names.contains(&"delete_folder".to_owned()));
    assert_eq!(names.len(), 14);

    let (error, texts, _) = h
        .tool(
            &read,
            "create_document",
            json!({ "library_id": Uuid::now_v7(), "file_name": "a.md", "content": "x" }),
        )
        .await;
    assert!(error, "{texts:?}");
}

#[sqlx::test(migrator = "mdr_server::MIGRATOR")]
async fn mcp_reads_and_edits_documents_and_files(pool: PgPool) {
    let h = Harness::new(pool.clone());
    let admin = h.admin(&pool).await;
    let lib = h
        .api(
            Method::POST,
            "/libraries",
            &admin,
            Some(json!({ "name": "Work" })),
        )
        .await
        .body["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let key = h.key(&admin, "write", true).await;

    let libraries = h.tool_json(&key, "list_libraries", json!({})).await;
    assert_eq!(libraries[0]["id"], lib.as_str());

    // Folders and text documents.
    let folder = h
        .tool_json(
            &key,
            "create_folder",
            json!({ "library_id": lib, "name": "Plans" }),
        )
        .await;
    let folder_id = folder["id"].as_str().expect("folder").to_owned();
    let doc = h
        .tool_json(&key, "create_document", json!({ "library_id": lib, "file_name": "roadmap.md", "content": "# Roadmap\nship it", "folder_id": folder_id }))
        .await;
    let doc_id = doc["id"].as_str().expect("doc").to_owned();
    let listing = h
        .tool_json(&key, "list_documents", json!({ "library_id": lib }))
        .await;
    assert_eq!(listing["folders"][0]["path"], "Plans");
    assert_eq!(listing["documents"][0]["path"], "Plans/roadmap.md");

    let (error, texts, _) = h
        .tool(&key, "read_document", json!({ "document_id": doc_id }))
        .await;
    assert!(!error);
    let meta: Value = serde_json::from_str(&texts[0]).expect("meta");
    assert_eq!(texts[1], "# Roadmap\nship it");
    let head = meta["head_revision_id"].as_str().expect("head").to_owned();
    let (_, texts, _) = h
        .tool(
            &key,
            "read_document",
            json!({ "document_id": doc_id, "offset": 2, "limit": 7 }),
        )
        .await;
    assert_eq!(texts[1], "Roadmap");

    let updated = h
        .tool_json(&key, "update_document", json!({ "document_id": doc_id, "content": "# Roadmap\nshipped", "base_revision_id": head }))
        .await;
    assert_eq!(updated["title"], "Roadmap");
    // A stale base is a conflict the model is told how to resolve.
    let (error, texts, _) = h
        .tool(
            &key,
            "update_document",
            json!({ "document_id": doc_id, "content": "lost", "base_revision_id": head }),
        )
        .await;
    assert!(
        error && texts[0].contains("sync.conflict") && texts[0].contains("read it again"),
        "{texts:?}"
    );

    let hits = h
        .tool_json(
            &key,
            "search",
            json!({ "library_id": lib, "query": "shipped" }),
        )
        .await;
    assert_eq!(hits[0]["document_id"], doc_id.as_str());

    let moved = h
        .tool_json(
            &key,
            "rename_or_move_document",
            json!({ "document_id": doc_id, "new_file_name": "road.md", "folder_id": null }),
        )
        .await;
    assert_eq!(
        (moved["file_name"].as_str(), moved["folder_id"].is_null()),
        (Some("road.md"), true)
    );
    let renamed = h
        .tool_json(
            &key,
            "rename_or_move_folder",
            json!({ "folder_id": folder_id, "new_name": "Archive" }),
        )
        .await;
    assert_eq!(renamed["name"], "Archive");

    // Office files: read as text, downloaded and replaced as bytes.
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut ids = Vec::new();
    for (name, format, expected) in [
        ("sample.docx", "docx", None),
        ("sample.xlsx", "xlsx", Some("| A |")),
        ("sample.ods", "ods", Some("| A |")),
        ("sample.pdf", "pdf", Some("--- page 1 ---")),
    ] {
        let created = h
            .tool_json(&key, "upload_file", json!({ "library_id": lib, "file_name": name, "content_base64": b64.encode(fixture(name)) }))
            .await;
        let id = created["id"].as_str().expect("id").to_owned();
        let (error, texts, _) = h
            .tool(&key, "read_document", json!({ "document_id": id }))
            .await;
        assert!(!error, "{name}: {texts:?}");
        let meta: Value = serde_json::from_str(&texts[0]).expect("meta");
        assert_eq!(meta["extracted_text_of"], format, "{name}");
        assert!(!texts[1].trim().is_empty(), "{name}");
        if let Some(expected) = expected {
            assert!(texts[1].contains(expected), "{name}: {}", texts[1]);
        }
        ids.push((
            id,
            name,
            meta["head_revision_id"].as_str().expect("head").to_owned(),
        ));
    }
    let (pdf_id, _, pdf_head) = ids.last().cloned().expect("pdf");
    let (error, texts, result) = h
        .tool(&key, "download_file", json!({ "document_id": pdf_id }))
        .await;
    assert!(!error, "{texts:?}");
    let blob = result["content"][1]["resource"]["blob"]
        .as_str()
        .expect("blob");
    assert_eq!(b64.decode(blob).expect("base64"), fixture("sample.pdf"));
    assert_eq!(
        result["content"][1]["resource"]["mimeType"],
        "application/pdf"
    );

    let mut new_pdf = fixture("sample.pdf");
    new_pdf.extend_from_slice(b"\n% edited\n");
    let replaced = h
        .tool_json(&key, "replace_file", json!({ "document_id": pdf_id, "content_base64": b64.encode(&new_pdf), "base_revision_id": pdf_head }))
        .await;
    assert_ne!(replaced["head_revision_id"], pdf_head.as_str());
    let (error, texts, _) = h
        .tool(
            &key,
            "upload_file",
            json!({ "library_id": lib, "file_name": "x.exe", "content_base64": "AAAA" }),
        )
        .await;
    assert!(error && texts[0].contains(".docx"), "{texts:?}");
    let (error, texts, _) = h
        .tool(
            &key,
            "update_document",
            json!({ "document_id": pdf_id, "content": "x", "base_revision_id": pdf_head }),
        )
        .await;
    assert!(error && texts[0].contains("document.not_text"), "{texts:?}");

    // Deletion.
    let (error, _, _) = h
        .tool(&key, "delete_document", json!({ "document_id": doc_id }))
        .await;
    assert!(!error);
    let (error, _, _) = h
        .tool(&key, "delete_folder", json!({ "folder_id": folder_id }))
        .await;
    assert!(!error);
    let listing = h
        .tool_json(&key, "list_documents", json!({ "library_id": lib }))
        .await;
    assert_eq!(listing["folders"], json!([]));
    assert_eq!(listing["documents"].as_array().map(Vec::len), Some(4));
    let (error, texts, _) = h
        .tool(&key, "read_document", json!({ "document_id": doc_id }))
        .await;
    assert!(
        error && texts[0].contains("document.not_found"),
        "{texts:?}"
    );
}
