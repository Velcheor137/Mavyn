//! MCP server at `/mcp` (Streamable HTTP, stateless, JSON responses) so AI clients such as Claude
//! Code can browse, read and edit a Mavyn library with an API key:
//!
//! ```text
//! claude mcp add --transport http mavyn https://notes.example/mcp --header "Authorization: Bearer mvn_…"
//! ```
//!
//! Every tool is a thin adapter over the REST API: it calls the same `/api/v1` routes in-process
//! with the caller's key, so permissions, key scope, compare-and-swap, validation and rate limits
//! are enforced in exactly one place. Only API keys are accepted here (no cookies, so a web page
//! cannot drive it), and requests from a foreign browser `Origin` are refused.

use crate::auth::{authenticate_token, bearer, AuthUser, TokenAccess, TOKEN_PREFIX};
use crate::crypto;
use crate::extract;
use crate::state::AppState;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    InitializeResult, ListToolsResult, PaginatedRequestParams, ResourceContents,
    ServerCapabilities, Tool, ToolAnnotations,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, ServerHandler};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

/// Characters `read_document` returns by default and at most per call.
const DEFAULT_READ_CHARS: usize = 100_000;
const MAX_READ_CHARS: usize = 400_000;

/// The caller of one `/mcp` request, put into the request extensions by [`require_api_key`].
#[derive(Clone)]
struct Caller {
    key: String,
    user: AuthUser,
}

/// `/mcp` with its API-key guard. `api` is the `/api/v1` router (with state) the tools call.
pub fn router(state: AppState, api: Router) -> Router {
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None)
        // A public server: `Host` is not restricted (keys authenticate every request, and the
        // `Origin` check below blocks browsers); request size is bounded by the largest upload.
        .disable_allowed_hosts()
        .with_max_request_body_bytes(state.config.max_file_bytes / 3 * 4 + 1024 * 1024);
    let handler = MavynMcp { api };
    let service = StreamableHttpService::new(
        move || Ok(handler.clone()),
        Arc::new(NeverSessionManager::default()),
        config,
    );
    Router::new()
        .route_service("/mcp", service)
        .layer(axum::middleware::from_fn_with_state(state, require_api_key))
}

fn unauthorized() -> Response {
    let mut response = (
        StatusCode::UNAUTHORIZED,
        axum::Json(json!({ "error": { "code": "auth.required", "details": {
            "hint": "Send an API key created in Mavyn (Settings → API keys) as `Authorization: Bearer mvn_…`."
        } } })),
    )
        .into_response();
    response.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Bearer realm=\"Mavyn\""),
    );
    response
}

/// Accepts only API keys and refuses foreign browser origins (MCP DNS-rebinding guidance).
async fn require_api_key(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    if let (Some(expected), Some(origin)) = (
        &state.config.public_origin,
        request.headers().get(header::ORIGIN),
    ) {
        if origin.to_str().ok() != Some(expected.as_str()) {
            return (
                StatusCode::FORBIDDEN,
                axum::Json(json!({ "error": { "code": "auth.forbidden", "details": { "origin": "not allowed" } } })),
            )
                .into_response();
        }
    }
    let Some(key) = bearer(request.headers())
        .filter(|t| t.starts_with(TOKEN_PREFIX))
        .map(str::to_owned)
    else {
        return unauthorized();
    };
    let user = match authenticate_token(&state, &key).await {
        Ok(user) => user,
        Err(e) if e.status == StatusCode::UNAUTHORIZED => return unauthorized(),
        Err(e) => return e.into_response(),
    };
    request.extensions_mut().insert(Caller { key, user });
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Clone)]
struct MavynMcp {
    api: Router,
}

/// A failed tool call, returned to the model as an error result it can act on.
type ToolResult = Result<CallToolResult, CallToolResult>;

fn fail(message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message.into())])
}

fn ok_text(text: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(text.into())])
}

fn ok_json(value: &Value) -> CallToolResult {
    ok_text(serde_json::to_string_pretty(value).unwrap_or_default())
}

struct Reply {
    status: StatusCode,
    body: Bytes,
}

impl Reply {
    fn json(&self) -> Result<Value, CallToolResult> {
        if !self.status.is_success() {
            return Err(self.error());
        }
        if self.body.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&self.body).map_err(|_| fail("unexpected response from the server"))
    }

    fn bytes(&self) -> Result<Bytes, CallToolResult> {
        if !self.status.is_success() {
            return Err(self.error());
        }
        Ok(self.body.clone())
    }

    /// The API's `{"error": {code, details}}` with a hint for the model.
    fn error(&self) -> CallToolResult {
        let body: Value = serde_json::from_slice(&self.body).unwrap_or(Value::Null);
        let code = body["error"]["code"].as_str().unwrap_or("unknown");
        let details = &body["error"]["details"];
        let hint = match code {
            "sync.conflict" => " The document changed since base_revision_id: read it again and retry with the new head_revision_id.",
            "token.forbidden" => " This API key does not allow it (read-only key, no delete permission, or an account-only action).",
            "auth.forbidden" => " Your role in this library does not allow it.",
            "library.not_found" | "document.not_found" | "folder.not_found" => " It does not exist, or it is outside this API key's libraries.",
            "document.not_text" => " This is a file document (docx/xlsx/ods/pdf): use replace_file to write it.",
            "document.not_file" => " This is a text document: use update_document to write it.",
            "file.unsupported" => " Only docx, xlsx, ods and pdf files can be uploaded, and their bytes must match the type.",
            "file.too_large" | "request.too_large" => " The content is larger than the server allows.",
            "request.rate_limited" => " Too many requests with this key: wait a minute.",
            _ => "",
        };
        let details = if details.is_null() {
            String::new()
        } else {
            format!(" {details}")
        };
        fail(format!(
            "Mavyn API error {} {code}{details}.{hint}",
            self.status.as_u16()
        ))
    }
}

/// Minimal percent-encoding for query values.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn args<T: for<'de> Deserialize<'de>>(arguments: &Map<String, Value>) -> Result<T, CallToolResult> {
    serde_json::from_value(Value::Object(arguments.clone()))
        .map_err(|e| fail(format!("invalid arguments: {e}")))
}

/// An optional nullable id argument: absent = keep, `null` = library root, a UUID = that folder.
fn folder_arg(
    arguments: &Map<String, Value>,
    name: &str,
) -> Result<Option<Option<Uuid>>, CallToolResult> {
    match arguments.get(name) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => Uuid::parse_str(s)
            .map(|id| Some(Some(id)))
            .map_err(|_| fail(format!("invalid arguments: {name} must be a UUID or null"))),
        Some(_) => Err(fail(format!(
            "invalid arguments: {name} must be a UUID or null"
        ))),
    }
}

fn decode_base64(data: &str) -> Result<Vec<u8>, CallToolResult> {
    let compact: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    BASE64
        .decode(compact)
        .map_err(|_| fail("invalid arguments: content_base64 is not valid base64"))
}

fn mime_for(file_name: &str) -> Option<&'static str> {
    let lower = file_name.to_lowercase();
    let ext = lower.rsplit_once('.')?.1;
    Some(match ext {
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

impl MavynMcp {
    /// Calls an `/api/v1` route in-process as the caller.
    async fn call(
        &self,
        caller: &Caller,
        method: Method,
        path: &str,
        body: Option<Body>,
        content_type: &str,
    ) -> Result<Reply, CallToolResult> {
        let request = axum::http::Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {}", caller.key))
            .header(header::CONTENT_TYPE, content_type)
            .header("idempotency-key", Uuid::now_v7().to_string())
            .body(body.unwrap_or_else(Body::empty))
            .map_err(|_| fail("invalid request"))?;
        let response = self
            .api
            .clone()
            .oneshot(request)
            .await
            .map_err(|_| fail("internal error"))?;
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .map_err(|_| fail("internal error"))?;
        Ok(Reply { status, body })
    }

    async fn get(&self, caller: &Caller, path: &str) -> Result<Reply, CallToolResult> {
        self.call(caller, Method::GET, path, None, "application/json")
            .await
    }

    async fn send_json(
        &self,
        caller: &Caller,
        method: Method,
        path: &str,
        body: &Value,
    ) -> Result<Reply, CallToolResult> {
        self.call(
            caller,
            method,
            path,
            Some(Body::from(body.to_string())),
            "application/json",
        )
        .await
    }

    async fn run(&self, caller: &Caller, name: &str, a: &Map<String, Value>) -> ToolResult {
        match name {
            "list_libraries" => {
                let libraries = self.get(caller, "/libraries").await?.json()?;
                Ok(ok_json(&libraries))
            }
            "list_documents" => self.list_documents(caller, a).await,
            "search" => {
                #[derive(Deserialize)]
                struct A {
                    library_id: Uuid,
                    query: String,
                }
                let A { library_id, query } = args(a)?;
                let hits = self
                    .get(
                        caller,
                        &format!("/libraries/{library_id}/search?q={}", encode(&query)),
                    )
                    .await?
                    .json()?;
                Ok(ok_json(&hits))
            }
            "read_document" => self.read_document(caller, a).await,
            "download_file" => {
                #[derive(Deserialize)]
                struct A {
                    document_id: Uuid,
                }
                let A { document_id } = args(a)?;
                let info = self
                    .get(caller, &format!("/documents/{document_id}/info"))
                    .await?
                    .json()?;
                if info["kind"] != "file" {
                    return Err(fail("This is a text document: use read_document."));
                }
                let bytes = self
                    .get(caller, &format!("/documents/{document_id}/file"))
                    .await?
                    .bytes()?;
                let file_name = info["file_name"].as_str().unwrap_or("file");
                let mut resource = ResourceContents::blob(
                    BASE64.encode(&bytes),
                    format!("mavyn://documents/{document_id}/{}", encode(file_name)),
                );
                if let ResourceContents::BlobResourceContents { mime_type, .. } = &mut resource {
                    *mime_type = info["mime"].as_str().map(str::to_owned);
                }
                Ok(CallToolResult::success(vec![
                    ContentBlock::text(format!(
                        "{file_name} ({} bytes, head_revision_id {})",
                        bytes.len(),
                        info["head_revision_id"].as_str().unwrap_or("")
                    )),
                    ContentBlock::resource(resource),
                ]))
            }
            "create_document" => {
                #[derive(Deserialize)]
                struct A {
                    library_id: Uuid,
                    file_name: String,
                    content: String,
                    #[serde(default)]
                    folder_id: Option<Uuid>,
                }
                let A {
                    library_id,
                    file_name,
                    content,
                    folder_id,
                } = args(a)?;
                let body = json!({ "id": Uuid::now_v7(), "file_name": file_name, "content": content, "folder_id": folder_id });
                let created = self
                    .send_json(
                        caller,
                        Method::POST,
                        &format!("/libraries/{library_id}/documents"),
                        &body,
                    )
                    .await?
                    .json()?;
                Ok(ok_json(&created))
            }
            "update_document" => {
                #[derive(Deserialize)]
                struct A {
                    document_id: Uuid,
                    content: String,
                    base_revision_id: Uuid,
                }
                let A {
                    document_id,
                    content,
                    base_revision_id,
                } = args(a)?;
                let body = json!({
                    "base_revision_id": base_revision_id,
                    "content_hash": crypto::sha256_hex(content.as_bytes()),
                    "content": content,
                });
                let updated = self
                    .send_json(
                        caller,
                        Method::PUT,
                        &format!("/documents/{document_id}/content"),
                        &body,
                    )
                    .await?
                    .json()?;
                Ok(ok_json(&updated))
            }
            "upload_file" => {
                #[derive(Deserialize)]
                struct A {
                    library_id: Uuid,
                    file_name: String,
                    content_base64: String,
                    #[serde(default)]
                    folder_id: Option<Uuid>,
                }
                let A {
                    library_id,
                    file_name,
                    content_base64,
                    folder_id,
                } = args(a)?;
                let mime = mime_for(&file_name)
                    .ok_or_else(|| fail("file_name must end in .docx, .xlsx, .ods or .pdf"))?;
                let bytes = decode_base64(&content_base64)?;
                let mut path = format!(
                    "/libraries/{library_id}/files?id={}&file_name={}&sha256={}&mime={}",
                    Uuid::now_v7(),
                    encode(&file_name),
                    crypto::sha256_hex(&bytes),
                    encode(mime)
                );
                if let Some(folder) = folder_id {
                    path.push_str(&format!("&folder_id={folder}"));
                }
                let created = self
                    .call(
                        caller,
                        Method::POST,
                        &path,
                        Some(Body::from(bytes)),
                        "application/octet-stream",
                    )
                    .await?
                    .json()?;
                Ok(ok_json(&created))
            }
            "replace_file" => {
                #[derive(Deserialize)]
                struct A {
                    document_id: Uuid,
                    content_base64: String,
                    base_revision_id: Uuid,
                }
                let A {
                    document_id,
                    content_base64,
                    base_revision_id,
                } = args(a)?;
                let bytes = decode_base64(&content_base64)?;
                let path = format!(
                    "/documents/{document_id}/file?base_revision_id={base_revision_id}&sha256={}",
                    crypto::sha256_hex(&bytes)
                );
                let updated = self
                    .call(
                        caller,
                        Method::PUT,
                        &path,
                        Some(Body::from(bytes)),
                        "application/octet-stream",
                    )
                    .await?
                    .json()?;
                Ok(ok_json(&updated))
            }
            "rename_or_move_document" => self.move_document(caller, a).await,
            "rename_or_move_folder" => self.move_folder(caller, a).await,
            "create_folder" => {
                #[derive(Deserialize)]
                struct A {
                    library_id: Uuid,
                    name: String,
                    #[serde(default)]
                    parent_folder_id: Option<Uuid>,
                }
                let A {
                    library_id,
                    name,
                    parent_folder_id,
                } = args(a)?;
                let body =
                    json!({ "id": Uuid::now_v7(), "name": name, "parent_id": parent_folder_id });
                let created = self
                    .send_json(
                        caller,
                        Method::POST,
                        &format!("/libraries/{library_id}/folders"),
                        &body,
                    )
                    .await?
                    .json()?;
                Ok(ok_json(&created))
            }
            "delete_document" | "delete_folder" => {
                let (field, route) = if name == "delete_document" {
                    ("document_id", "documents")
                } else {
                    ("folder_id", "folders")
                };
                let id = a
                    .get(field)
                    .and_then(Value::as_str)
                    .and_then(|s| Uuid::parse_str(s).ok())
                    .ok_or_else(|| fail(format!("invalid arguments: {field} must be a UUID")))?;
                self.call(
                    caller,
                    Method::DELETE,
                    &format!("/{route}/{id}"),
                    None,
                    "application/json",
                )
                .await?
                .json()?;
                Ok(ok_text(format!("Deleted {route} {id}.")))
            }
            _ => Err(fail(format!("unknown tool {name}"))),
        }
    }

    /// The live folders and documents of a library, from the change feed.
    async fn list_documents(&self, caller: &Caller, a: &Map<String, Value>) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            library_id: Uuid,
            #[serde(default)]
            folder_id: Option<Uuid>,
        }
        let A {
            library_id,
            folder_id,
        } = args(a)?;
        let mut cursor = String::new();
        let mut documents: Vec<Value> = Vec::new();
        let mut folders: HashMap<String, Value> = HashMap::new();
        loop {
            let page = self
                .get(
                    caller,
                    &format!("/libraries/{library_id}/changes?limit=1000&cursor={cursor}"),
                )
                .await?
                .json()?;
            for d in page["documents"].as_array().into_iter().flatten() {
                if d["deleted_at"].is_null() {
                    documents.push(d.clone());
                }
            }
            for f in page["folders"].as_array().into_iter().flatten() {
                if f["deleted_at"].is_null() {
                    if let Some(id) = f["id"].as_str() {
                        folders.insert(id.to_owned(), f.clone());
                    }
                }
            }
            cursor = page["cursor"].as_str().unwrap_or_default().to_owned();
            if page["has_more"] != true {
                break;
            }
        }
        let path_of = |mut id: Option<String>| -> (String, Vec<String>) {
            let mut names = Vec::new();
            let mut chain = Vec::new();
            while let Some(current) = id.take() {
                if chain.contains(&current) || names.len() > 64 {
                    break;
                }
                let Some(folder) = folders.get(&current) else {
                    break;
                };
                names.push(folder["name"].as_str().unwrap_or("").to_owned());
                chain.push(current);
                id = folder["parent_id"].as_str().map(str::to_owned);
            }
            names.reverse();
            (names.join("/"), chain)
        };
        let wanted = folder_id.map(|f| f.to_string());
        if let Some(w) = &wanted {
            if !folders.contains_key(w) {
                return Err(fail("folder.not_found: no such folder in this library"));
            }
        }
        let in_scope = |chain: &[String]| wanted.as_ref().is_none_or(|w| chain.contains(w));
        let mut folder_list: Vec<Value> = folders
            .values()
            .filter_map(|f| {
                let (path, chain) = path_of(f["id"].as_str().map(str::to_owned));
                in_scope(&chain).then(|| json!({ "id": f["id"], "name": f["name"], "parent_id": f["parent_id"], "path": path }))
            })
            .collect();
        folder_list.sort_by(|x, y| x["path"].as_str().cmp(&y["path"].as_str()));
        let mut document_list: Vec<Value> = documents
            .iter()
            .filter_map(|d| {
                let (folder_path, chain) = path_of(d["folder_id"].as_str().map(str::to_owned));
                if !in_scope(&chain) {
                    return None;
                }
                let file_name = d["file_name"].as_str().unwrap_or("");
                let path = if folder_path.is_empty() {
                    file_name.to_owned()
                } else {
                    format!("{folder_path}/{file_name}")
                };
                Some(json!({
                    "id": d["id"], "title": d["title"], "file_name": d["file_name"], "path": path,
                    "kind": d["kind"], "mime": d["mime"], "folder_id": d["folder_id"],
                    "head_revision_id": d["head_revision_id"], "updated_at": d["updated_at"],
                }))
            })
            .collect();
        document_list.sort_by(|x, y| x["path"].as_str().cmp(&y["path"].as_str()));
        Ok(ok_json(
            &json!({ "folders": folder_list, "documents": document_list }),
        ))
    }

    async fn read_document(&self, caller: &Caller, a: &Map<String, Value>) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            document_id: Uuid,
            #[serde(default)]
            offset: usize,
            #[serde(default)]
            limit: Option<usize>,
        }
        let A {
            document_id,
            offset,
            limit,
        } = args(a)?;
        let limit = limit.unwrap_or(DEFAULT_READ_CHARS).clamp(1, MAX_READ_CHARS);
        let info = self
            .get(caller, &format!("/documents/{document_id}/info"))
            .await?
            .json()?;
        let (text, extracted_from, cut_by_extractor) = if info["kind"] == "file" {
            let bytes = self
                .get(caller, &format!("/documents/{document_id}/file"))
                .await?
                .bytes()?;
            match extract::extract_async(bytes.to_vec()).await {
                Ok(e) => (e.text, Some(e.format), e.truncated),
                Err(e) => {
                    return Err(fail(format!(
                        "Could not extract text ({e}). download_file returns the original bytes."
                    )))
                }
            }
        } else {
            let doc = self
                .get(caller, &format!("/documents/{document_id}"))
                .await?
                .json()?;
            (
                doc["content"].as_str().unwrap_or_default().to_owned(),
                None,
                false,
            )
        };
        let total = text.chars().count();
        let slice: String = text.chars().skip(offset).take(limit).collect();
        let returned = slice.chars().count();
        let mut meta = json!({
            "id": info["id"], "title": info["title"], "file_name": info["file_name"],
            "kind": info["kind"], "mime": info["mime"], "head_revision_id": info["head_revision_id"],
            "total_chars": total, "offset": offset, "returned_chars": returned,
            "more": offset + returned < total,
        });
        if let Some(format) = extracted_from {
            meta["extracted_text_of"] = json!(format);
            meta["note"] = json!("Read-only text extracted from the file. To change the file, upload a complete new version with replace_file.");
            if cut_by_extractor {
                meta["extractor_truncated"] = json!(true);
            }
        }
        Ok(CallToolResult::success(vec![
            ContentBlock::text(serde_json::to_string_pretty(&meta).unwrap_or_default()),
            ContentBlock::text(slice),
        ]))
    }

    async fn move_document(&self, caller: &Caller, a: &Map<String, Value>) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            document_id: Uuid,
            #[serde(default)]
            new_file_name: Option<String>,
        }
        let A {
            document_id,
            new_file_name,
        } = args(a)?;
        let target = folder_arg(a, "folder_id")?;
        let info = self
            .get(caller, &format!("/documents/{document_id}/info"))
            .await?
            .json()?;
        let base_name = info["file_name"].as_str().unwrap_or_default().to_owned();
        let base_folder = info["folder_id"].clone();
        let body = json!({
            "base_file_name": base_name,
            "base_folder_id": base_folder,
            "file_name": new_file_name.as_deref().unwrap_or(&base_name),
            "folder_id": match target { None => base_folder.clone(), Some(f) => json!(f) },
        });
        let updated = self
            .send_json(
                caller,
                Method::PATCH,
                &format!("/documents/{document_id}"),
                &body,
            )
            .await?
            .json()?;
        let applied =
            updated["file_name"] == body["file_name"] && updated["folder_id"] == body["folder_id"];
        let mut result = ok_json(&updated);
        if !applied {
            result.content.push(ContentBlock::text(
                "Not every change was applied: the target folder does not exist, or the document changed meanwhile.",
            ));
        }
        Ok(result)
    }

    async fn move_folder(&self, caller: &Caller, a: &Map<String, Value>) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            folder_id: Uuid,
            #[serde(default)]
            new_name: Option<String>,
        }
        let A {
            folder_id,
            new_name,
        } = args(a)?;
        let target = folder_arg(a, "parent_folder_id")?;
        let info = self
            .get(caller, &format!("/folders/{folder_id}"))
            .await?
            .json()?;
        let base_name = info["name"].as_str().unwrap_or_default().to_owned();
        let base_parent = info["parent_id"].clone();
        let body = json!({
            "base_name": base_name,
            "base_parent_id": base_parent,
            "name": new_name.as_deref().unwrap_or(&base_name),
            "parent_id": match target { None => base_parent.clone(), Some(f) => json!(f) },
        });
        let updated = self
            .send_json(
                caller,
                Method::PATCH,
                &format!("/folders/{folder_id}"),
                &body,
            )
            .await?
            .json()?;
        let applied = updated["name"] == body["name"] && updated["parent_id"] == body["parent_id"];
        let mut result = ok_json(&updated);
        if !applied {
            result.content.push(ContentBlock::text(
                "Not every change was applied: the target folder does not exist, is inside this folder, or the folder changed meanwhile.",
            ));
        }
        Ok(result)
    }
}

fn schema(value: Value) -> Arc<Map<String, Value>> {
    match value {
        Value::Object(map) => Arc::new(map),
        _ => Arc::new(Map::new()),
    }
}

fn tool(name: &'static str, description: &'static str, input: Value, kind: Kind) -> Tool {
    let annotations = match kind {
        Kind::Read => ToolAnnotations::new().read_only(true),
        Kind::Write => ToolAnnotations::new().read_only(false).destructive(false),
        Kind::Delete => ToolAnnotations::new().read_only(false).destructive(true),
    };
    Tool::new(name, description, schema(input)).with_annotations(annotations)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Read,
    Write,
    Delete,
}

const UUID: &str = "uuid";

fn id_prop(description: &str) -> Value {
    json!({ "type": "string", "format": UUID, "description": description })
}

/// Every tool with the permission it needs.
fn all_tools() -> Vec<(Tool, Kind)> {
    let library = id_prop("Library id from list_libraries.");
    let document = id_prop("Document id from list_documents or search.");
    let base = id_prop("head_revision_id from your latest read of this document (compare-and-swap: a newer version on the server makes the write fail instead of overwriting it).");
    vec![
        (tool("list_libraries", "List the libraries this API key can access, with your role in each.",
            json!({ "type": "object", "properties": {} }), Kind::Read), Kind::Read),
        (tool("list_documents", "List the folders and documents of a library (or of one folder subtree) with their paths, kind (text or file), MIME type and head_revision_id.",
            json!({ "type": "object", "properties": { "library_id": library, "folder_id": id_prop("Only this folder and its subfolders (optional).") }, "required": ["library_id"] }), Kind::Read), Kind::Read),
        (tool("search", "Full-text search in a library (prefix match on words; text documents by content, files by title). Returns document ids, titles and highlighted snippets.",
            json!({ "type": "object", "properties": { "library_id": library, "query": { "type": "string" } }, "required": ["library_id", "query"] }), Kind::Read), Kind::Read),
        (tool("read_document", "Read a document as text. Text documents (Markdown, code, plain text) return their content. Files return extracted text: docx as text with headings and tables, xlsx/ods as one table per sheet (column letters and row numbers), pdf as text per page. Long texts are paged with offset/limit (characters). Also returns head_revision_id, needed to write.",
            json!({ "type": "object", "properties": { "document_id": document, "offset": { "type": "integer", "minimum": 0, "description": "First character to return (default 0)." }, "limit": { "type": "integer", "minimum": 1, "maximum": MAX_READ_CHARS, "description": "Characters to return (default 100000)." } }, "required": ["document_id"] }), Kind::Read), Kind::Read),
        (tool("download_file", "Download the original bytes of a file document (docx/xlsx/ods/pdf) as a base64 resource.",
            json!({ "type": "object", "properties": { "document_id": document }, "required": ["document_id"] }), Kind::Read), Kind::Read),
        (tool("create_document", "Create a text document (Markdown, code, plain text; any file name). The content is UTF-8 text.",
            json!({ "type": "object", "properties": { "library_id": library, "file_name": { "type": "string", "description": "For example notes.md or script.py." }, "content": { "type": "string" }, "folder_id": id_prop("Folder to create it in (optional; library root by default).") }, "required": ["library_id", "file_name", "content"] }), Kind::Write), Kind::Write),
        (tool("update_document", "Replace the whole content of a text document.",
            json!({ "type": "object", "properties": { "document_id": document, "content": { "type": "string", "description": "The complete new content." }, "base_revision_id": base }, "required": ["document_id", "content", "base_revision_id"] }), Kind::Write), Kind::Write),
        (tool("upload_file", "Upload a new docx, xlsx, ods or pdf file (base64).",
            json!({ "type": "object", "properties": { "library_id": library, "file_name": { "type": "string", "description": "Must end in .docx, .xlsx, .ods or .pdf." }, "content_base64": { "type": "string" }, "folder_id": id_prop("Folder to put it in (optional).") }, "required": ["library_id", "file_name", "content_base64"] }), Kind::Write), Kind::Write),
        (tool("replace_file", "Replace a file document (docx/xlsx/ods/pdf) with a complete new version of the same type (base64). Its original import stays available in Mavyn.",
            json!({ "type": "object", "properties": { "document_id": document, "content_base64": { "type": "string" }, "base_revision_id": base }, "required": ["document_id", "content_base64", "base_revision_id"] }), Kind::Write), Kind::Write),
        (tool("rename_or_move_document", "Rename a document and/or move it to another folder.",
            json!({ "type": "object", "properties": { "document_id": document, "new_file_name": { "type": "string" }, "folder_id": { "type": ["string", "null"], "format": UUID, "description": "Target folder; null for the library root; omit to keep the folder." } }, "required": ["document_id"] }), Kind::Write), Kind::Write),
        (tool("rename_or_move_folder", "Rename a folder and/or move it under another folder.",
            json!({ "type": "object", "properties": { "folder_id": id_prop("Folder to change."), "new_name": { "type": "string" }, "parent_folder_id": { "type": ["string", "null"], "format": UUID, "description": "New parent; null for the library root; omit to keep it." } }, "required": ["folder_id"] }), Kind::Write), Kind::Write),
        (tool("create_folder", "Create a folder.",
            json!({ "type": "object", "properties": { "library_id": library, "name": { "type": "string" }, "parent_folder_id": id_prop("Parent folder (optional; library root by default).") }, "required": ["library_id", "name"] }), Kind::Write), Kind::Write),
        (tool("delete_document", "Delete a document (it disappears on every device).",
            json!({ "type": "object", "properties": { "document_id": document }, "required": ["document_id"] }), Kind::Delete), Kind::Delete),
        (tool("delete_folder", "Delete a folder together with all its subfolders and documents.",
            json!({ "type": "object", "properties": { "folder_id": id_prop("Folder to delete.") }, "required": ["folder_id"] }), Kind::Delete), Kind::Delete),
    ]
}

fn allowed(user: &AuthUser, kind: Kind) -> bool {
    match (user.token(), kind) {
        (_, Kind::Read) => true,
        (Some(scope), Kind::Write) => scope.access == TokenAccess::Write,
        (Some(scope), Kind::Delete) => scope.access == TokenAccess::Write && scope.can_delete,
        (None, _) => false,
    }
}

fn caller_of(context: &RequestContext<RoleServer>) -> Result<Caller, ErrorData> {
    context
        .extensions
        .get::<axum::http::request::Parts>()
        .and_then(|parts| parts.extensions.get::<Caller>())
        .cloned()
        .ok_or_else(|| ErrorData::invalid_request("an API key is required", None))
}

impl ServerHandler for MavynMcp {
    fn get_info(&self) -> InitializeResult {
        InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("mavyn", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Mavyn is a document library that syncs across the user's devices. Start with \
                 list_libraries, then list_documents or search. Text documents (Markdown, code, \
                 plain text) are read and written as text. Files (docx, xlsx, ods, pdf) are read as \
                 extracted text and written only as complete new files (base64). Every write needs \
                 the head_revision_id of your latest read as base_revision_id; on a conflict, read \
                 again and redo the change. Changes appear on the user's devices on their next sync.",
            )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let caller = caller_of(&context)?;
        let tools = all_tools()
            .into_iter()
            .filter(|(_, kind)| allowed(&caller.user, *kind))
            .map(|(tool, _)| tool)
            .collect();
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let caller = caller_of(&context)?;
        let Some(kind) = all_tools()
            .into_iter()
            .find(|(tool, _)| tool.name == request.name)
            .map(|(_, kind)| kind)
        else {
            return Err(ErrorData::invalid_params(
                format!("unknown tool {}", request.name),
                None,
            ));
        };
        if !allowed(&caller.user, kind) {
            return Ok(fail("This API key does not allow this tool.").into());
        }
        let arguments = request.arguments.unwrap_or_default();
        let result = match self.run(&caller, &request.name, &arguments).await {
            Ok(result) | Err(result) => result,
        };
        Ok(result.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_are_unique_and_schemas_are_objects() {
        let tools = all_tools();
        let mut names: Vec<&str> = tools.iter().map(|(t, _)| t.name.as_ref()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), tools.len());
        for (tool, _) in &tools {
            assert_eq!(
                tool.input_schema.get("type"),
                Some(&json!("object")),
                "{}",
                tool.name
            );
        }
    }

    #[test]
    fn mime_types_by_extension() {
        assert_eq!(mime_for("Report.PDF"), Some("application/pdf"));
        assert_eq!(
            mime_for("a.b.xlsx"),
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        );
        assert_eq!(mime_for("notes.md"), None);
        assert_eq!(mime_for("noext"), None);
    }
}
