use crate::{CmdResult, CommandError};
use mavyn_native_sync::{Client, Request, Response, Vault};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub struct SyncHost(pub Mutex<Client>);

struct NativeVault {
    _app: AppHandle,
}

#[cfg(target_os = "android")]
impl NativeVault {
    fn call(
        &self,
        method: &str,
        payload: serde_json::Value,
    ) -> mavyn_native_sync::Result<serde_json::Value> {
        let reply = self
            ._app
            .state::<tauri_plugin_mavyn_files::Files<tauri::Wry>>()
            .call(method, payload)
            .map_err(|_| "storage.failed")?;
        if reply.get("error").is_some() {
            return Err("storage.failed");
        }
        Ok(reply
            .get("value")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }
}

impl Vault for NativeVault {
    fn get(&self, key: &str) -> mavyn_native_sync::Result<Option<String>> {
        #[cfg(target_os = "windows")]
        {
            mavyn_native_sync::WindowsVault.get(key)
        }
        #[cfg(target_os = "android")]
        {
            Ok(self
                .call("readSession", serde_json::json!({ "key": key }))?
                .as_str()
                .map(str::to_owned))
        }
        #[cfg(not(any(target_os = "android", target_os = "windows")))]
        {
            let _ = key;
            Err("server.unavailable")
        }
    }

    fn set(&self, key: &str, value: &str) -> mavyn_native_sync::Result<()> {
        #[cfg(target_os = "windows")]
        {
            mavyn_native_sync::WindowsVault.set(key, value)
        }
        #[cfg(target_os = "android")]
        {
            self.call(
                "storeSession",
                serde_json::json!({ "key": key, "value": value }),
            )?;
            Ok(())
        }
        #[cfg(not(any(target_os = "android", target_os = "windows")))]
        {
            let _ = (key, value);
            Err("server.unavailable")
        }
    }

    fn delete(&self, key: &str) -> mavyn_native_sync::Result<()> {
        #[cfg(target_os = "windows")]
        {
            mavyn_native_sync::WindowsVault.delete(key)
        }
        #[cfg(target_os = "android")]
        {
            self.call("clearSession", serde_json::json!({ "key": key }))?;
            Ok(())
        }
        #[cfg(not(any(target_os = "android", target_os = "windows")))]
        {
            let _ = key;
            Err("server.unavailable")
        }
    }
}

#[tauri::command]
pub fn native_sync_supported() -> bool {
    cfg!(any(target_os = "android", target_os = "windows"))
}

#[tauri::command]
pub fn native_sync_url(url: String) -> CmdResult<String> {
    mavyn_native_sync::normalize_url(&url).map_err(CommandError::new)
}

#[tauri::command]
pub async fn native_sync_request(
    app: AppHandle,
    base_url: String,
    request: Request,
) -> CmdResult<Response> {
    let host = app.state::<Arc<SyncHost>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let client = host
            .0
            .lock()
            .map_err(|_| CommandError::new("storage.failed"))?;
        client
            .request(&base_url, &request, &NativeVault { _app: app })
            .map_err(CommandError::new)
    })
    .await
    .map_err(|_| CommandError::new("network.failed"))?
}
