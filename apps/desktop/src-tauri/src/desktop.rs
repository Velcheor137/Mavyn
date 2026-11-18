use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use mavyn_local_store::files::{write_atomic, write_linked_checked};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::{CmdResult, CommandError, Fingerprint, PickedFile};

pub struct Allowed {
    paths: Mutex<HashSet<PathBuf>>,
    store: PathBuf,
    launch_files: Mutex<Vec<PathBuf>>,
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

/// Bytes read for the webview, handed over once as a raw IPC response by `take_transfer`.
#[derive(Default)]
pub struct Transfers(Mutex<HashMap<String, Vec<u8>>>);

impl Transfers {
    fn put(&self, bytes: Vec<u8>) -> CmdResult<String> {
        let token = uuid::Uuid::new_v4().to_string();
        self.0
            .lock()
            .map_err(|_| CommandError::new("unknown"))?
            .insert(token.clone(), bytes);
        Ok(token)
    }
}

/// Takes the bytes behind a token from `pick_markdown_files`, `take_launch_files` or `read_linked`.
#[tauri::command]
pub fn take_transfer(
    transfers: State<'_, Transfers>,
    token: String,
) -> CmdResult<tauri::ipc::Response> {
    let bytes = transfers
        .0
        .lock()
        .map_err(|_| CommandError::new("unknown"))?
        .remove(&token)
        .ok_or(CommandError::new("file.not_found"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Arguments of raw-body commands, sent as base64 JSON in the `x-mavyn-args` header (paths may
/// contain non-ASCII characters, which header values cannot).
fn raw_args<T: for<'de> Deserialize<'de>>(request: &tauri::ipc::Request<'_>) -> CmdResult<T> {
    let header = request
        .headers()
        .get("x-mavyn-args")
        .and_then(|v| v.to_str().ok())
        .ok_or(CommandError::new("edit.invalid_range"))?;
    let json = B64
        .decode(header)
        .map_err(|_| CommandError::new("edit.invalid_range"))?;
    serde_json::from_slice(&json).map_err(|_| CommandError::new("edit.invalid_range"))
}

fn raw_body(request: &tauri::ipc::Request<'_>) -> CmdResult<Vec<u8>> {
    crate::body_bytes(request.body(), "edit.invalid_range")
}

fn read_picked(allowed: &Allowed, transfers: &Transfers, path: &Path) -> CmdResult<PickedFile> {
    let canonical = allowed.allow(path)?;
    let bytes = fs::read(&canonical)?;
    Ok(PickedFile {
        name: canonical
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("document.md")
            .to_owned(),
        fingerprint: fingerprint_of(&canonical, &bytes)?,
        bytes_token: transfers.put(bytes)?,
        locator: format!("path:{}", canonical.display()),
    })
}

#[tauri::command]
pub async fn pick_markdown_files(
    app: tauri::AppHandle,
    allowed: State<'_, Allowed>,
    transfers: State<'_, Transfers>,
    multiple: bool,
    link: bool,
) -> CmdResult<Vec<PickedFile>> {
    let _ = link; // Desktop file permissions are granted by the native picker.
    let dialog = app
        .dialog()
        .file()
        .add_filter(
            "Markdown, Word, Excel, OpenDocument, PDF",
            &[
                "md", "markdown", "mdown", "mkd", "txt", "docx", "xlsx", "ods", "pdf",
            ],
        )
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd", "txt"])
        // View-only binary documents; imported as copies.
        .add_filter(
            "Word, Excel, OpenDocument, PDF",
            &["docx", "xlsx", "ods", "pdf"],
        )
        // Any text file (code, logs, configs): the content decides, not the extension.
        .add_filter("*", &["*"]);
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
        out.push(read_picked(&allowed, &transfers, &path)?);
    }
    Ok(out)
}

/// Files passed on the command line / via "Open with" at launch (taken once).
#[tauri::command]
pub fn take_launch_files(
    allowed: State<'_, Allowed>,
    transfers: State<'_, Transfers>,
) -> CmdResult<Vec<PickedFile>> {
    let files: Vec<PathBuf> = std::mem::take(
        &mut *allowed
            .launch_files
            .lock()
            .map_err(|_| CommandError::new("unknown"))?,
    );
    files
        .iter()
        .map(|p| read_picked(&allowed, &transfers, p))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    bytes_token: String,
    fingerprint: Fingerprint,
}

#[tauri::command]
pub fn read_linked(
    allowed: State<'_, Allowed>,
    transfers: State<'_, Transfers>,
    locator: String,
) -> CmdResult<ReadResult> {
    let path = allowed.check(&locator)?;
    let bytes = fs::read(&path)?;
    Ok(ReadResult {
        fingerprint: fingerprint_of(&path, &bytes)?,
        bytes_token: transfers.put(bytes)?,
    })
}

#[derive(Deserialize)]
struct WriteArgs {
    locator: String,
    expected: Fingerprint,
}

/// Writes only if the file still matches `expected` (content hash decides when size/mtime differ).
/// The bytes are the raw IPC body; `locator` and `expected` come in `x-mavyn-args`.
#[tauri::command]
pub fn write_linked(
    allowed: State<'_, Allowed>,
    request: tauri::ipc::Request<'_>,
) -> CmdResult<Fingerprint> {
    let args: WriteArgs = raw_args(&request)?;
    let bytes = raw_body(&request)?;
    let path = allowed.check(&args.locator)?;
    write_linked_checked(&path, &bytes, &args.expected.content_hash).map_err(CommandError::new)?;
    fingerprint_of(&path, &bytes)
}

#[derive(Deserialize)]
struct SaveArgs {
    name: String,
}

#[tauri::command]
pub async fn save_as(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> CmdResult<bool> {
    let SaveArgs { name } = raw_args(&request)?;
    let bytes = raw_body(&request)?;
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

pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let dir = app.path().app_data_dir()?;
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
    app.manage(Transfers::default());
    Ok(())
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
