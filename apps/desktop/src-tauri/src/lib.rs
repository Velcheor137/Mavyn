//! Native SQLite shell with platform-specific, user-granted file access.
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Manager, State};

#[cfg(target_os = "android")]
mod android;
#[cfg(not(target_os = "android"))]
mod desktop;

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
    bytes_base64: String,
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
                local_store,
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
            platform_kind
        ]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running Mavyn");
}
