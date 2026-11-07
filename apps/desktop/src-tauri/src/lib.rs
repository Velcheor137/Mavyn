//! Native shell: file access is limited to files the user picked or opened via the OS, recorded
//! in an allow-list persisted in the app data directory. The webview cannot read arbitrary paths.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use mavyn_local_store::files::{write_atomic, write_linked_checked};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

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

struct Allowed {
    paths: Mutex<HashSet<PathBuf>>,
    store: PathBuf,
    launch_files: Mutex<Vec<PathBuf>>,
}

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

impl Allowed {
    fn allow(&self, path: &Path) -> CmdResult<PathBuf> {
        let canonical = fs::canonicalize(path)?;
        let mut paths = self
            .paths
            .lock()
            .map_err(|_| CommandError::new("unknown"))?;
        if paths.insert(canonical.clone()) {
            let list: Vec<_> = paths.iter().collect();
            if let Ok(json) = serde_json::to_vec(&list) {
                // Best effort: losing the list only means re-picking files after restart.
                let _ = write_atomic(&self.store, &json);
            }
        }
        Ok(canonical)
    }

    fn check(&self, locator: &str) -> CmdResult<PathBuf> {
        let path = locator
            .strip_prefix("path:")
            .ok_or(CommandError::new("file.not_found"))?;
        let canonical = fs::canonicalize(path)?;
        let paths = self
            .paths
            .lock()
            .map_err(|_| CommandError::new("unknown"))?;
        if paths.contains(&canonical) {
            Ok(canonical)
        } else {
            Err(CommandError::new("file.permission_denied"))
        }
    }
}

fn fingerprint_of(path: &Path, bytes: &[u8]) -> CmdResult<Fingerprint> {
    let meta = fs::metadata(path)?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Ok(Fingerprint {
        size: meta.len(),
        modified_ms,
        content_hash: hex::encode(Sha256::digest(bytes)),
    })
}

fn read_picked(allowed: &Allowed, path: &Path) -> CmdResult<PickedFile> {
    let canonical = allowed.allow(path)?;
    let bytes = fs::read(&canonical)?;
    Ok(PickedFile {
        name: canonical
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("document.md")
            .to_owned(),
        fingerprint: fingerprint_of(&canonical, &bytes)?,
        bytes_base64: B64.encode(&bytes),
        locator: format!("path:{}", canonical.display()),
    })
}

#[tauri::command]
async fn pick_markdown_files(
    app: tauri::AppHandle,
    allowed: State<'_, Allowed>,
    multiple: bool,
) -> CmdResult<Vec<PickedFile>> {
    let dialog = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd", "txt"]);
    let picked = if multiple {
        dialog.blocking_pick_files()
    } else {
        dialog.blocking_pick_file().map(|f| vec![f])
    };
    let mut out = Vec::new();
    for file in picked.unwrap_or_default() {
        let path = file
            .into_path()
            .map_err(|_| CommandError::new("file.unsupported"))?;
        out.push(read_picked(&allowed, &path)?);
    }
    Ok(out)
}

/// Files passed on the command line / via "Open with" at launch (taken once).
#[tauri::command]
fn take_launch_files(allowed: State<'_, Allowed>) -> CmdResult<Vec<PickedFile>> {
    let files: Vec<PathBuf> = std::mem::take(
        &mut *allowed
            .launch_files
            .lock()
            .map_err(|_| CommandError::new("unknown"))?,
    );
    files.iter().map(|p| read_picked(&allowed, p)).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadResult {
    bytes_base64: String,
    fingerprint: Fingerprint,
}

#[tauri::command]
fn read_linked(allowed: State<'_, Allowed>, locator: String) -> CmdResult<ReadResult> {
    let path = allowed.check(&locator)?;
    let bytes = fs::read(&path)?;
    Ok(ReadResult {
        fingerprint: fingerprint_of(&path, &bytes)?,
        bytes_base64: B64.encode(bytes),
    })
}

/// Writes only if the file still matches `expected` (content hash decides when size/mtime differ).
#[tauri::command]
fn write_linked(
    allowed: State<'_, Allowed>,
    locator: String,
    bytes_base64: String,
    expected: Fingerprint,
) -> CmdResult<Fingerprint> {
    let path = allowed.check(&locator)?;
    let bytes = B64
        .decode(bytes_base64)
        .map_err(|_| CommandError::new("edit.invalid_range"))?;
    write_linked_checked(&path, &bytes, &expected.content_hash).map_err(CommandError::new)?;
    fingerprint_of(&path, &bytes)
}

#[tauri::command]
async fn save_as(app: tauri::AppHandle, name: String, bytes_base64: String) -> CmdResult<bool> {
    let bytes = B64
        .decode(bytes_base64)
        .map_err(|_| CommandError::new("edit.invalid_range"))?;
    let Some(target) = app
        .dialog()
        .file()
        .set_file_name(&name)
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = target
        .into_path()
        .map_err(|_| CommandError::new("file.unsupported"))?;
    write_atomic(&path, &bytes)?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(Arc::new(
                mavyn_local_store::StoreHost::new(dir.join("library.sqlite3"))
                    .map_err(std::io::Error::other)?,
            ));
            let store = dir.join("allowed-files.json");
            let paths: HashSet<PathBuf> = fs::read(&store)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default();
            let launch_files = std::env::args_os()
                .skip(1)
                .map(PathBuf::from)
                .filter(|p| p.is_file())
                .collect();
            app.manage(Allowed {
                paths: Mutex::new(paths),
                store,
                launch_files: Mutex::new(launch_files),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_markdown_files,
            take_launch_files,
            read_linked,
            write_linked,
            save_as,
            local_store
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mavyn");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_files() {
        let dir = std::env::temp_dir().join(format!("mdr-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("dir");
        let target = dir.join("note.md");
        write_atomic(&target, b"one").expect("write");
        write_atomic(&target, "два".as_bytes()).expect("write");
        assert_eq!(fs::read_to_string(&target).expect("read"), "два");
        assert_eq!(fs::read_dir(&dir).expect("ls").count(), 1);
        fs::remove_dir_all(dir).expect("cleanup");
    }
}
