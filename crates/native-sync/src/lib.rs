//! Restricted native HTTP transport. Bearer values never cross the webview boundary.
use reqwest::{blocking::Client as HttpClient, redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::time::Duration;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::WindowsVault;

pub type Result<T> = std::result::Result<T, &'static str>;
/// JSON requests carry whole text documents (up to 256 MiB on the server); JSON escaping can
/// grow them, so allow twice that plus room for metadata.
const MAX_BODY: u64 = 2 * 256 * 1024 * 1024 + 65536;
/// Binary documents (docx, xlsx, ods, pdf): 50 MiB plus room for an error body.
const MAX_FILE_BODY: u64 = 50 * 1024 * 1024 + 65536;
/// A 50 MiB upload or download on a slow link needs far longer than JSON requests.
const FILE_TIMEOUT: Duration = Duration::from_secs(600);

pub trait Vault {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn set(&self, key: &str, value: &str) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub body: Option<Value>,
    pub op_id: Option<String>,
}

#[derive(Serialize)]
pub struct Response {
    pub status: u16,
    pub body: Value,
}

/// Raw-bytes exchange for binary documents: upload (`POST …/files`) and download (`GET …/file`).
pub struct BinaryRequest {
    pub method: String,
    pub path: String,
    pub op_id: Option<String>,
}

pub struct BinaryResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub fn normalize_url(input: &str) -> Result<String> {
    let url = Url::parse(input.trim()).map_err(|_| "server.invalid_url")?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
    if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("server.invalid_url");
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

pub fn session_key(base: &str) -> String {
    hex::encode(Sha256::digest(base.as_bytes()))
}

/// Query keys the upload route accepts (all URL-encoded scalars).
const UPLOAD_QUERY: [&str; 5] = ["id", "file_name", "folder_id", "sha256", "mime"];
/// Query of `PUT /documents/{id}/file` (replacing an edited binary document's bytes).
const REPLACE_QUERY: &[&str] = &["base_revision_id", "sha256"];

fn route(base: &str, request: &Request) -> Result<Url> {
    route_for(
        base,
        &request.method,
        &request.path,
        request.op_id.as_deref(),
        request.body.is_some(),
        false,
    )
}

/// Validates a request against the protocol allow-list. `binary` selects the raw-bytes routes,
/// which are never reachable through the JSON transport and vice versa.
fn route_for(
    base: &str,
    method: &str,
    path: &str,
    op_id: Option<&str>,
    has_json_body: bool,
    binary: bool,
) -> Result<Url> {
    if !path.starts_with("/api/v1/") || path.len() > 4096 {
        return Err("network.failed");
    }
    let url = Url::parse(&format!("{base}{path}")).map_err(|_| "network.failed")?;
    let parts: Vec<_> = url
        .path()
        .trim_start_matches("/api/v1/")
        .split('/')
        .collect();
    let id = |value: &str| uuid::Uuid::parse_str(value).is_ok();
    let upload = matches!(parts.as_slice(), ["libraries", library, "files"] if id(library) && method == "POST");
    let download = matches!(parts.as_slice(), ["documents", document, "file" | "original"] if id(document) && method == "GET");
    let replace = matches!(parts.as_slice(), ["documents", document, "file"] if id(document) && method == "PUT");
    if binary {
        let query_ok = if upload {
            url.query_pairs()
                .all(|(key, value)| UPLOAD_QUERY.contains(&key.as_ref()) && value.len() <= 1024)
        } else if replace {
            url.query_pairs()
                .all(|(key, value)| REPLACE_QUERY.contains(&key.as_ref()) && value.len() <= 128)
        } else {
            url.query().is_none()
        };
        if !(upload || download || replace)
            || !query_ok
            || url.fragment().is_some()
            || op_id.is_some_and(|value| !id(value))
        {
            return Err("network.failed");
        }
        return Ok(url);
    }
    let allowed = match parts.as_slice() {
        ["health"] => method == "GET",
        ["setup"] => matches!(method, "GET" | "POST"),
        ["auth", "me"] => method == "GET",
        ["auth", "login" | "logout"] => method == "POST",
        ["libraries"] => matches!(method, "GET" | "POST"),
        ["libraries", library, "changes"] => id(library) && method == "GET",
        ["libraries", library, "documents" | "folders"] => id(library) && method == "POST",
        ["documents", document] => id(document) && matches!(method, "GET" | "PATCH" | "DELETE"),
        ["folders", folder] => id(folder) && matches!(method, "PATCH" | "DELETE"),
        ["documents", document, "content"] => id(document) && method == "PUT",
        _ => false,
    };
    let changes = matches!(parts.as_slice(), ["libraries", _, "changes"]);
    if !allowed
        || url.fragment().is_some()
        || url.query().is_some()
            && (!changes
                || url
                    .query_pairs()
                    .any(|(key, value)| !(key == "cursor" && value.len() <= 2048)))
        || op_id.is_some_and(|value| !id(value))
        || method == "GET" && has_json_body
    {
        return Err("network.failed");
    }
    Ok(url)
}

pub struct Client(HttpClient);
impl Client {
    /// Uploads or downloads a binary document. Bytes pass through unchanged; the status and the
    /// server's (JSON error or document) body are returned as they are.
    pub fn request_bytes(
        &self,
        base: &str,
        request: &BinaryRequest,
        body: Option<&[u8]>,
        vault: &dyn Vault,
    ) -> Result<BinaryResponse> {
        let base = normalize_url(base)?;
        let url = route_for(
            &base,
            &request.method,
            &request.path,
            request.op_id.as_deref(),
            false,
            true,
        )?;
        if body.is_some_and(|b| b.len() as u64 > MAX_FILE_BODY) {
            return Err("file.too_large");
        }
        let token = vault.get(&session_key(&base))?;
        let method = request.method.parse().map_err(|_| "network.failed")?;
        let mut builder = self
            .0
            .request(method, url)
            .header("x-sync-protocol", "2")
            .timeout(FILE_TIMEOUT);
        if let Some(token) = &token {
            builder = builder.bearer_auth(token);
        }
        if let Some(op_id) = &request.op_id {
            builder = builder.header("idempotency-key", op_id);
        }
        if let Some(body) = body {
            builder = builder
                .header("content-type", "application/octet-stream")
                .body(body.to_vec());
        }
        let response = builder.send().map_err(|_| "sync.offline")?;
        if response.status().is_redirection() {
            return Err("network.failed");
        }
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        response
            .take(MAX_FILE_BODY + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "sync.offline")?;
        if bytes.len() as u64 > MAX_FILE_BODY {
            return Err("file.too_large");
        }
        if status == 401 {
            vault.delete(&session_key(&base))?;
        }
        Ok(BinaryResponse {
            status,
            body: bytes,
        })
    }

    pub fn new() -> Result<Self> {
        HttpClient::builder()
            .redirect(Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(25))
            .build()
            .map(Self)
            .map_err(|_| "network.failed")
    }

    pub fn request(&self, base: &str, request: &Request, vault: &dyn Vault) -> Result<Response> {
        let base = normalize_url(base)?;
        let url = route(&base, request)?;
        let key = session_key(&base);
        let login = url.path() == "/api/v1/auth/login";
        let logout = url.path() == "/api/v1/auth/logout";
        let token = vault.get(&key)?;
        if login {
            vault.delete(&key)?;
        }
        // Logout forgets the native credential even when revocation cannot reach the server.
        if logout {
            vault.delete(&key)?;
        }
        let outcome = (|| {
            let method = request.method.parse().map_err(|_| "network.failed")?;
            let mut builder = self.0.request(method, url).header("x-sync-protocol", "2");
            // Reading a whole text document (up to 256 MiB) may take long on a slow link.
            if request.method == "GET"
                && request
                    .path
                    .trim_start_matches('/')
                    .starts_with("documents/")
            {
                builder = builder.timeout(FILE_TIMEOUT);
            }
            if !login {
                if let Some(token) = &token {
                    builder = builder.bearer_auth(token);
                }
            }
            if let Some(op_id) = &request.op_id {
                builder = builder.header("idempotency-key", op_id);
            }
            if let Some(body) = &request.body {
                let body = serde_json::to_vec(body).map_err(|_| "network.failed")?;
                if body.len() as u64 > MAX_BODY {
                    return Err("file.too_large");
                }
                // A large text document needs as long as a file upload on a slow link.
                if body.len() > 1024 * 1024 {
                    builder = builder.timeout(FILE_TIMEOUT);
                }
                builder = builder
                    .header("content-type", "application/json")
                    .body(body);
            }
            let response = builder.send().map_err(|_| "sync.offline")?;
            if response.status().is_redirection() {
                return Err("network.failed");
            }
            let status = response.status().as_u16();
            if status == 204 {
                return Ok(Response {
                    status,
                    body: Value::Null,
                });
            }
            let mut bytes = Vec::new();
            response
                .take(MAX_BODY + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "network.failed")?;
            if bytes.len() as u64 > MAX_BODY {
                return Err("file.too_large");
            }
            let mut body: Value =
                serde_json::from_slice(&bytes).map_err(|_| "server.unavailable")?;
            if login && (200..300).contains(&status) {
                let token = body
                    .get_mut("token")
                    .and_then(|value| value.as_str())
                    .ok_or("auth.required")?
                    .to_owned();
                if token.len() > 8192 || token.is_empty() {
                    return Err("auth.required");
                }
                vault.set(&key, &token)?;
                body.as_object_mut().ok_or("auth.required")?.remove("token");
            }
            if status == 401 {
                vault.delete(&key)?;
            }
            Ok(Response { status, body })
        })();
        if logout {
            return Ok(Response {
                status: 204,
                body: Value::Null,
            });
        }
        outcome
    }
}

#[cfg(test)]
mod tests;
