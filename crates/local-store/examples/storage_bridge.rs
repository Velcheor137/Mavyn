//! Test harness only: JSON-lines transport to the same engine used by Tauri.
use mavyn_local_store::StoreHost;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| ":memory:".into());
    let store = StoreHost::new(path).expect("create test database host");
    for line in io::stdin().lock().lines() {
        let line = line.expect("read request");
        let input: Value = serde_json::from_str(&line).expect("JSON request");
        let result = match input.get("file") {
            // Binary channel (raw IPC payloads in the app); hex keeps this harness line-based.
            Some(file) => {
                let token = file["token"].as_str().unwrap_or_default();
                let hash = file["hash"].as_str().unwrap_or_default();
                match file["op"].as_str() {
                    Some("putFile") => hex::decode(file["bytesHex"].as_str().unwrap_or_default())
                        .map_err(|_| "storage.failed".to_owned())
                        .and_then(|bytes| store.put_file(token, hash, &bytes))
                        .map(|()| Value::Null),
                    Some("getFile") => store
                        .get_file(token, hash)
                        .map(|bytes| json!(hex::encode(bytes.unwrap_or_default()))),
                    _ => Err("storage.failed".to_owned()),
                }
            }
            None => store.handle(input["request"].clone()),
        };
        let response = match result {
            Ok(value) => json!({"id":input["id"],"value":value}),
            Err(code) => json!({"id":input["id"],"error":{"code":code}}),
        };
        println!("{response}");
        io::stdout().flush().expect("flush response");
    }
}
