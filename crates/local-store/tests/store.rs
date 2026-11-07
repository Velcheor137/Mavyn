use mavyn_local_store::LocalStore;
use serde_json::{json, Value};

fn call(store: &mut LocalStore, request: Value) -> Value {
    store.handle(request).expect("request")
}
fn begin(store: &mut LocalStore, mode: &str) -> Value {
    call(
        store,
        json!({"op":"begin","mode":mode,"stores":["documents","contents","revisions","folders","settings","handles","syncBases"]}),
    )
}
fn put(store: &mut LocalStore, token: &Value, table: &str, value: Value) {
    call(
        store,
        json!({"op":"put","token":token,"store":table,"value":value}),
    );
}
fn seed(store: &mut LocalStore) {
    let token = begin(store, "readwrite");
    put(
        store,
        &token,
        "contents",
        json!({"hash":"h","text":"# Ёжик\r\n\r\nСписок задач: Buy MILK 🦔"}),
    );
    put(
        store,
        &token,
        "revisions",
        json!({"id":"r","documentId":"d","contentHash":"h"}),
    );
    put(
        store,
        &token,
        "documents",
        json!({"id":"d","title":"Ёжик","contentHash":"h","deletedAt":null}),
    );
    call(store, json!({"op":"commit","token":token}));
}

#[test]
fn commits_reopens_and_preserves_exact_text() {
    let dir = std::env::temp_dir().join(format!("mavyn-store-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join("library.sqlite3");
    {
        let mut db = LocalStore::open(&path).expect("open");
        seed(&mut db);
    }
    let mut db = LocalStore::open(&path).expect("reopen");
    let token = begin(&mut db, "readonly");
    assert_eq!(
        call(
            &mut db,
            json!({"op":"get","token":token,"store":"contents","key":"h"})
        )["text"],
        "# Ёжик\r\n\r\nСписок задач: Buy MILK 🦔"
    );
    assert_eq!(
        call(
            &mut db,
            json!({"op":"revisions","token":token,"documentId":"d"})
        )
        .as_array()
        .expect("array")
        .len(),
        1
    );
    call(&mut db, json!({"op":"commit","token":token}));
    drop(db);
    std::fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn rollback_discards_uncommitted_writes() {
    let mut db = LocalStore::open(":memory:").expect("open");
    let token = begin(&mut db, "readwrite");
    put(&mut db, &token, "settings", json!({"key":"x","value":1}));
    call(&mut db, json!({"op":"rollback","token":token}));
    let token = begin(&mut db, "readonly");
    assert!(call(
        &mut db,
        json!({"op":"get","token":token,"store":"settings","key":"x"})
    )
    .is_null());
    call(&mut db, json!({"op":"commit","token":token}));
}

#[test]
fn enforces_scope_readonly_and_opaque_tokens() {
    let mut db = LocalStore::open(":memory:").expect("open");
    let token = call(
        &mut db,
        json!({"op":"begin","mode":"readonly","stores":["settings"]}),
    );
    for req in [
        json!({"op":"put","token":token,"store":"settings","value":{"key":"x"}}),
        json!({"op":"all","token":token,"store":"documents"}),
        json!({"op":"commit","token":"wrong"}),
        json!({"op":"begin","mode":"readwrite","stores":["settings"]}),
    ] {
        assert!(db.handle(req).is_err());
    }
    call(&mut db, json!({"op":"rollback","token":token}));
    assert!(db
        .handle(json!({"op":"begin","mode":"readwrite","stores":["arbitrary_sql"]}))
        .is_err());
}

#[test]
fn searches_fts5_cyrillic_prefixes_unicode_and_tracks_trash_restore() {
    let mut db = LocalStore::open(":memory:").expect("open");
    seed(&mut db);
    for query in ["ежик", "ЗАДАЧ", "milk", "задач milk", "ёжик"] {
        let hits = call(&mut db, json!({"op":"search","terms":[query],"limit":50}));
        // Mixed queries are supplied as individual terms by the TS tokenizer.
        if query != "задач milk" {
            assert_eq!(hits[0]["documentId"], "d", "query {query}");
        }
    }
    assert_eq!(
        call(
            &mut db,
            json!({"op":"search","terms":["задач","milk"],"limit":50})
        )[0]["documentId"],
        "d"
    );
    assert!(call(
        &mut db,
        json!({"op":"search","terms":["\" OR *"],"limit":50})
    )
    .as_array()
    .expect("array")
    .is_empty());
    let token = begin(&mut db, "readwrite");
    put(
        &mut db,
        &token,
        "documents",
        json!({"id":"d","title":"Ёжик","contentHash":"h","deletedAt":"2026-01-01"}),
    );
    call(&mut db, json!({"op":"commit","token":token}));
    assert!(
        call(&mut db, json!({"op":"search","terms":["milk"],"limit":50}))
            .as_array()
            .expect("array")
            .is_empty()
    );
    let token = begin(&mut db, "readwrite");
    put(
        &mut db,
        &token,
        "documents",
        json!({"id":"d","title":"Ёжик","contentHash":"h","deletedAt":null}),
    );
    call(&mut db, json!({"op":"commit","token":token}));
    assert_eq!(
        call(&mut db, json!({"op":"search","terms":["milk"],"limit":50}))[0]["documentId"],
        "d"
    );
}

#[test]
fn migration_marker_is_transactional() {
    let mut db = LocalStore::open(":memory:").expect("open");
    assert_eq!(
        call(&mut db, json!({"op":"status"}))["legacyImported"],
        false
    );
    let token = begin(&mut db, "readwrite");
    call(&mut db, json!({"op":"markImported","token":token}));
    call(&mut db, json!({"op":"rollback","token":token}));
    assert_eq!(
        call(&mut db, json!({"op":"status"}))["legacyImported"],
        false
    );
    let token = begin(&mut db, "readwrite");
    call(&mut db, json!({"op":"markImported","token":token}));
    call(&mut db, json!({"op":"commit","token":token}));
    assert_eq!(
        call(&mut db, json!({"op":"status"}))["legacyImported"],
        true
    );
}

#[test]
fn refuses_newer_schema_without_replacing_existing_data() {
    let dir = std::env::temp_dir().join(format!("mavyn-future-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join("library.sqlite3");
    let connection = rusqlite::Connection::open(&path).expect("open");
    connection.execute_batch("CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('keep'); PRAGMA user_version=2;").expect("future schema");
    drop(connection);
    assert_eq!(
        LocalStore::open(&path).err().expect("unsupported"),
        "storage.schema_unsupported"
    );
    let connection = rusqlite::Connection::open(&path).expect("reopen");
    assert_eq!(
        connection
            .query_row("SELECT value FROM future_data", [], |r| r
                .get::<_, String>(0))
            .expect("read"),
        "keep"
    );
    drop(connection);
    std::fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn closing_connection_rolls_back_uncommitted_writes() {
    let dir = std::env::temp_dir().join(format!("mavyn-drop-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join("library.sqlite3");
    {
        let mut db = LocalStore::open(&path).expect("open");
        let token = begin(&mut db, "readwrite");
        put(
            &mut db,
            &token,
            "settings",
            json!({"key":"uncommitted","value":1}),
        );
    }
    let mut db = LocalStore::open(&path).expect("reopen");
    assert_eq!(call(&mut db, json!({"op":"status"}))["empty"], true);
    drop(db);
    std::fs::remove_dir_all(dir).expect("cleanup");
}
