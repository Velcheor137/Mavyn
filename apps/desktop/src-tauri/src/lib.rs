//! Native SQLite shell with platform-specific, user-granted file access.
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Manager, State};

#[cfg(target_os = "android")]
mod android;
#[cfg(not(target_os = "android"))]
mod desktop;
mod sync;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    size: u64,
    modified_ms: u64,
    content_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    name: String,
    /// Desktop: the bytes wait in `desktop::Transfers` and are taken once with `take_transfer`
    /// as a raw IPC response (no base64 in JSON, files may be hundreds of MiB).
    bytes_token: String,
    locator: String,
    fingerprint: Fingerprint,
}

/// Error codes match `packages/core/src/errors.ts`.
#[derive(Debug, Serialize)]
pub struct CommandError {
    code: String,
}

impl CommandError {
    fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }
}

impl From<std::io::Error> for CommandError {
    fn from(error: std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::new("file.not_found"),
            std::io::ErrorKind::PermissionDenied => Self::new("file.permission_denied"),
            _ => Self::new("storage.failed"),
        }
    }
}

type CmdResult<T> = Result<T, CommandError>;

/// The path is fixed by setup; the webview can only send scoped store operations.
#[tauri::command]
async fn local_store(
    storage: State<'_, Arc<mavyn_local_store::StoreHost>>,
    request: serde_json::Value,
) -> CmdResult<serde_json::Value> {
    let storage = Arc::clone(storage.inner());
    tauri::async_runtime::spawn_blocking(move || storage.handle(request).map_err(CommandError::new))
        .await
        .map_err(|_| CommandError::new("storage.failed"))?
}

/// Raw-bytes channel for binary documents (docx, xlsx, ods, pdf): `putFile` carries the bytes as
/// the raw IPC body and `getFile` returns them as an `ArrayBuffer` — no JSON or base64 copies.
/// Operation, transaction token and hash travel in headers; scope checks are the store's.
#[tauri::command]
async fn local_store_file(
    storage: State<'_, Arc<mavyn_local_store::StoreHost>>,
    request: tauri::ipc::Request<'_>,
) -> CmdResult<tauri::ipc::Response> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| CommandError::new("storage.failed"))
    };
    let (op, token, hash) = (
        header("x-mavyn-op")?,
        header("x-mavyn-token")?,
        header("x-mavyn-hash")?,
    );
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => Vec::new(),
    };
    let storage = Arc::clone(storage.inner());
    let bytes = tauri::async_runtime::spawn_blocking(move || match op.as_str() {
        "putFile" => storage.put_file(&token, &hash, &body).map(|()| Vec::new()),
        "getFile" => storage
            .get_file(&token, &hash)
            .map(Option::unwrap_or_default),
        _ => Err("storage.failed".into()),
    })
    .await
    .map_err(|_| CommandError::new("storage.failed"))?
    .map_err(CommandError::new)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn platform_kind() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else {
        "desktop"
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().setup(|app| {
        let dir = app.path().app_data_dir()?;
        app.manage(Arc::new(
            mavyn_local_store::StoreHost::new(dir.join("library.sqlite3"))
                .map_err(std::io::Error::other)?,
        ));
        app.manage(Arc::new(sync::SyncHost(std::sync::Mutex::new(
            mavyn_native_sync::Client::new().map_err(std::io::Error::other)?,
        ))));
        #[cfg(not(target_os = "android"))]
        desktop::setup(app)?;
        Ok(())
    });
    #[cfg(not(target_os = "android"))]
    let builder =
        builder
            .plugin(tauri_plugin_dialog::init())
            .invoke_handler(tauri::generate_handler![
                desktop::pick_markdown_files,
                desktop::take_launch_files,
                desktop::read_linked,
                desktop::write_linked,
                desktop::save_as,
                desktop::take_transfer,
                local_store,
                local_store_file,
                sync::native_sync_supported,
                sync::native_sync_url,
                sync::native_sync_request,
                sync::native_sync_file,
                platform_kind
            ]);
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_mavyn_files::init())
        .invoke_handler(tauri::generate_handler![
            android::pick_markdown_files,
            android::take_launch_files,
            android::ack_incoming,
            android::read_linked,
            android::write_linked,
            android::save_as,
            local_store,
            local_store_file,
            sync::native_sync_supported,
            sync::native_sync_url,
            sync::native_sync_request,
            sync::native_sync_file,
            platform_kind
        ]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running Mavyn");
}
