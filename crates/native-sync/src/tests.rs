use super::*;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;

#[derive(Default)]
struct MemoryVault(Mutex<Option<String>>);
impl Vault for MemoryVault {
    fn get(&self, _: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn set(&self, _: &str, value: &str) -> Result<()> {
        *self.0.lock().unwrap() = Some(value.to_owned());
        Ok(())
    }
    fn delete(&self, _: &str) -> Result<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

#[test]
fn validates_origin_and_api_routes_before_accessing_credentials() {
    for bad in [
        "http://example.com",
        "https://user:pass@example.com",
        "https://example.com/path",
        "https://example.com?token=x",
        "file:///tmp/x",
        "https://example.com/#a",
    ] {
        assert!(normalize_url(bad).is_err(), "{bad}");
    }
    assert_eq!(
        normalize_url("https://EXAMPLE.com:443/").unwrap(),
        "https://example.com"
    );
    assert!(normalize_url("http://127.0.0.1:18881").is_ok());
    assert!(normalize_url("http://10.0.2.2:18881").is_err());
    let client = Client::new().unwrap();
    for path in [
        "//evil.test/api/v1/auth/me",
        "/api/v1/../private",
        "/api/v1/documents/not-a-uuid",
        "/api/v1/auth/me?leak=x",
    ] {
        assert!(client
            .request(
                "https://example.com",
                &Request {
                    method: "GET".into(),
                    path: path.into(),
                    body: None,
                    op_id: None
                },
                &MemoryVault::default()
            )
            .is_err());
    }
    assert_ne!(session_key("https://a.test"), session_key("https://b.test"));
}

#[test]
fn stores_login_bearer_natively_and_never_returns_it_to_javascript() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        for index in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut input = vec![0; 16384];
            let count = stream.read(&mut input).unwrap();
            let request = String::from_utf8_lossy(&input[..count]).to_lowercase();
            if index == 1 {
                assert!(request.contains("authorization: bearer secret-session"));
            }
            let body = if index == 0 {
                r#"{"token":"secret-session","csrf_token":"csrf","user":{"id":"u"}}"#
            } else {
                r#"{"id":"u","csrf_token":"csrf"}"#
            };
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        }
    });
    let vault = MemoryVault::default();
    let client = Client::new().unwrap();
    let response = client
        .request(
            &base,
            &Request {
                method: "POST".into(),
                path: "/api/v1/auth/login".into(),
                body: Some(json!({"username":"user", "password":"test-password"})),
                op_id: None,
            },
            &vault,
        )
        .unwrap();
    assert!(!response.body.to_string().contains("secret-session"));
    assert_eq!(
        vault.get(&session_key(&base)).unwrap().as_deref(),
        Some("secret-session")
    );
    client
        .request(
            &base,
            &Request {
                method: "GET".into(),
                path: "/api/v1/auth/me".into(),
                body: None,
                op_id: None,
            },
            &vault,
        )
        .unwrap();
    server.join().unwrap();
}

#[test]
fn refuses_redirects_and_clears_local_session_when_logout_is_offline() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut input = [0; 8192];
        let _ = stream.read(&mut input).unwrap();
        write!(stream, "HTTP/1.1 302 Found\r\nLocation: https://evil.invalid/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    let vault = MemoryVault::default();
    vault.set(&session_key(&base), "token").unwrap();
    let client = Client::new().unwrap();
    assert!(client
        .request(
            &base,
            &Request {
                method: "GET".into(),
                path: "/api/v1/auth/me".into(),
                body: None,
                op_id: None
            },
            &vault
        )
        .is_err());
    server.join().unwrap();
    let response = client
        .request(
            &base,
            &Request {
                method: "POST".into(),
                path: "/api/v1/auth/logout".into(),
                body: None,
                op_id: None,
            },
            &vault,
        )
        .unwrap();
    assert_eq!(response.status, 204);
    assert!(vault.get(&session_key(&base)).unwrap().is_none());
}

#[test]
fn binary_routes_are_separate_from_json_and_carry_raw_bytes() {
    let library = "0190a0b0-0000-7000-8000-000000000001";
    let document = "0190a0b0-0000-7000-8000-000000000002";
    let client = Client::new().unwrap();
    let vault = MemoryVault::default();
    // The JSON transport can neither upload nor download files.
    for (method, path) in [
        (
            "POST",
            format!("/api/v1/libraries/{library}/files?id={document}"),
        ),
        ("GET", format!("/api/v1/documents/{document}/file")),
    ] {
        assert!(client
            .request(
                "https://example.com",
                &Request {
                    method: method.into(),
                    path,
                    body: None,
                    op_id: None
                },
                &vault
            )
            .is_err());
    }
    // The binary transport only reaches those two routes, with the upload query keys only.
    for (method, path) in [
        ("GET", "/api/v1/auth/me".to_owned()),
        ("POST", format!("/api/v1/libraries/{library}/documents")),
        ("GET", format!("/api/v1/documents/{document}/file?x=1")),
        ("POST", format!("/api/v1/libraries/{library}/files?token=x")),
        ("DELETE", format!("/api/v1/documents/{document}/file")),
    ] {
        assert!(
            client
                .request_bytes(
                    "https://example.com",
                    &BinaryRequest {
                        method: method.into(),
                        path: path.clone(),
                        op_id: None
                    },
                    None,
                    &vault
                )
                .is_err(),
            "{method} {path}"
        );
    }

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let payload: Vec<u8> = (0..=255u8).cycle().take(100_000).collect();
    let expected = payload.clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut input = Vec::new();
        let mut buffer = [0u8; 65536];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            input.extend_from_slice(&buffer[..count]);
            if let Some(end) = input.windows(4).position(|w| w == b"\r\n\r\n") {
                if input.len() >= end + 4 + expected.len() {
                    let head = String::from_utf8_lossy(&input[..end]).to_lowercase();
                    assert!(head.contains("content-type: application/octet-stream"));
                    assert!(head.contains("idempotency-key: 0190a0b0-0000-7000-8000-000000000003"));
                    assert_eq!(&input[end + 4..], &expected[..]);
                    break;
                }
            }
        }
        let body = r#"{"id":"d","kind":"file"}"#;
        write!(stream, "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let response = client
        .request_bytes(
            &base,
            &BinaryRequest {
                method: "POST".into(),
                path: format!(
                    "/api/v1/libraries/{library}/files?id={document}&file_name=%D0%B0.pdf&sha256=ab&mime=application%2Fpdf"
                ),
                op_id: Some("0190a0b0-0000-7000-8000-000000000003".into()),
            },
            Some(&payload),
            &vault,
        )
        .unwrap();
    assert_eq!(response.status, 201);
    assert_eq!(response.body, br#"{"id":"d","kind":"file"}"#);
    server.join().unwrap();
}
