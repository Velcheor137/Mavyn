//! Android-only SAF transport. No filesystem or arbitrary-URI JavaScript API is exposed.
use serde::Serialize;
use serde_json::Value;
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

pub struct Files<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Files<R> {
    pub fn call(
        &self,
        method: &str,
        payload: impl Serialize,
    ) -> Result<Value, tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin(method, payload)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mavyn-files")
        // Kotlin methods (including the session vault) are Rust-only. Never fall through
        // from a webview plugin invocation into the mobile implementation.
        .invoke_handler(|invoke| {
            invoke
                .resolver
                .reject(serde_json::json!({ "code": "auth.forbidden" }));
            true
        })
        .setup(|app, api| {
            let handle = api.register_android_plugin("app.mavyn.files", "MavynFilesPlugin")?;
            app.manage(Files(handle));
            Ok(())
        })
        .build()
}
