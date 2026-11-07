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
        let response = match store.handle(input["request"].clone()) {
            Ok(value) => json!({"id":input["id"],"value":value}),
            Err(code) => json!({"id":input["id"],"error":{"code":code}}),
        };
        println!("{response}");
        io::stdout().flush().expect("flush response");
    }
}
