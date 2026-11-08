use crate::{CmdResult, CommandError, Fingerprint};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

async fn mobile(app: AppHandle, method: &'static str, payload: Value) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let reply = app
            .state::<tauri_plugin_mavyn_files::Files<tauri::Wry>>()
            .call(method, payload)
            .map_err(|_| CommandError::new("storage.failed"))?;
        if let Some(code) = reply.get("error").and_then(Value::as_str) {
            return Err(CommandError::new(code));
        }
        reply
            .get("value")
            .cloned()
            .ok_or(CommandError::new("storage.failed"))
    })
    .await
    .map_err(|_| CommandError::new("storage.failed"))?
}

#[tauri::command]
pub async fn pick_markdown_files(app: AppHandle, multiple: bool, link: bool) -> CmdResult<Value> {
    mobile(
        app,
        "pickFiles",
        json!({ "multiple": multiple, "link": link }),
    )
    .await
}

#[tauri::command]
pub fn take_launch_files() -> Value {
    // Android intent associations are disabled until their lifecycle is implemented.
    json!([])
}

#[tauri::command]
pub async fn read_linked(app: AppHandle, locator: String) -> CmdResult<Value> {
    mobile(app, "readLinked", json!({ "locator": locator })).await
}

#[tauri::command]
pub async fn write_linked(
    app: AppHandle,
    locator: String,
    bytes_base64: String,
    expected: Fingerprint,
) -> CmdResult<Value> {
    mobile(
        app,
        "writeLinked",
        json!({ "locator": locator, "bytesBase64": bytes_base64, "expected": expected }),
    )
    .await
}

#[tauri::command]
pub async fn save_as(app: AppHandle, name: String, bytes_base64: String) -> CmdResult<Value> {
    mobile(
        app,
        "saveAs",
        json!({ "name": name, "bytesBase64": bytes_base64 }),
    )
    .await
}
