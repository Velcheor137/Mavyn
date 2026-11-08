//! Opt-in native integration probe for an owned test server; never prints credentials.
#[cfg(target_os = "windows")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use mavyn_native_sync::{session_key, Client, Request, Vault, WindowsVault};
    let base = mavyn_native_sync::normalize_url(&std::env::var("MAVYN_QA_URL")?)?;
    let action = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "check".to_owned());
    let client = Client::new()?;
    let request = |method: &str, path: &str, body| {
        client.request(
            &base,
            &Request {
                method: method.to_owned(),
                path: path.to_owned(),
                body,
                op_id: None,
            },
            &WindowsVault,
        )
    };
    if action == "login" {
        let response = request(
            "POST",
            "/api/v1/auth/login",
            Some(serde_json::json!({
                "username": std::env::var("MAVYN_QA_USERNAME")?,
                "password": std::env::var("MAVYN_QA_PASSWORD")?,
                "device_name": "Windows native integration probe"
            })),
        )?;
        assert_eq!(response.status, 200);
        assert!(response.body.get("token").is_none());
    }
    if action == "logout" {
        request("POST", "/api/v1/auth/logout", None)?;
        assert!(WindowsVault.get(&session_key(&base))?.is_none());
        println!("Windows native logout cleared Credential Manager entry");
    } else {
        assert!(WindowsVault.get(&session_key(&base))?.is_some());
        let me = request("GET", "/api/v1/auth/me", None)?;
        assert_eq!(me.status, 200);
        let libraries = request("GET", "/api/v1/libraries", None)?;
        assert_eq!(libraries.status, 200);
        println!(
            "Windows Credential Manager restored authenticated session; libraries={}",
            libraries.body.as_array().map_or(0, Vec::len)
        );
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("This integration probe requires Windows Credential Manager.");
}
