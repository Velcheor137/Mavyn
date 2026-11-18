use mavyn_local_store::LocalStore;
use serde_json::{json, Value};

fn call(store: &mut LocalStore, request: Value) -> Value {
    store.handle(request).expect("request")
}
fn begin(store: &mut LocalStore, mode: &str) -> Value {
    call(
        store,
        json!({"op":"begin","mode":mode,"stores":["documents","contents","folders","settings","handles","syncBases"]}),
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
    connection.execute_batch("CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('keep'); PRAGMA user_version=4;").expect("future schema");
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

fn sha256(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}

#[test]
fn stores_binary_files_by_verified_hash_and_indexes_titles_only() {
    let dir = std::env::temp_dir().join(format!("mavyn-files-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join("library.sqlite3");
    let bytes: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
    let hash = sha256(&bytes);
    {
        let mut db = LocalStore::open(&path).expect("open");
        let files = json!({"op":"begin","mode":"readwrite","stores":["documents","files"]});
        let token = call(&mut db, files.clone());
        let t = token.as_str().expect("token");
        assert!(
            db.put_file(t, "0".repeat(64).as_str(), &bytes).is_err(),
            "hash must be verified"
        );
        db.put_file(t, &hash, &bytes).expect("put file");
        db.put_file(t, &hash, &bytes).expect("idempotent");
        assert!(db
            .handle(json!({"op":"put","token":token,"store":"files","value":{"hash":hash}}))
            .is_err());
        put(
            &mut db,
            &token,
            "documents",
            json!({"id":"f","kind":"file","title":"Квартальный отчёт","fileName":"Квартальный отчёт.pdf","contentHash":hash,"deletedAt":null}),
        );
        call(&mut db, json!({"op":"commit","token":token}));

        let token = call(
            &mut db,
            json!({"op":"begin","mode":"readonly","stores":["files"]}),
        );
        let t = token.as_str().expect("token");
        assert!(db.put_file(t, &hash, &bytes).is_err(), "readonly");
        assert_eq!(db.get_file(t, &hash).expect("get"), Some(bytes.clone()));
        assert_eq!(db.get_file(t, "missing").expect("get"), None);
        let all = call(&mut db, json!({"op":"all","token":token,"store":"files"}));
        assert_eq!(all, json!([{"hash":hash,"size":70_000}]));
        call(&mut db, json!({"op":"commit","token":token}));

        let hits = call(
            &mut db,
            json!({"op":"search","terms":["квартал"],"limit":10}),
        );
        assert_eq!(hits[0]["documentId"], "f");
        assert_eq!(hits[0]["text"], "");
    }
    {
        // Survives reopening; schema v2 is current.
        let mut db = LocalStore::open(&path).expect("reopen");
        let token = call(
            &mut db,
            json!({"op":"begin","mode":"readwrite","stores":["files"]}),
        );
        let t = token.as_str().expect("token").to_owned();
        assert_eq!(
            db.get_file(&t, &hash).expect("get").map(|b| b.len()),
            Some(70_000)
        );
        call(
            &mut db,
            json!({"op":"delete","token":token,"store":"files","key":hash}),
        );
        assert_eq!(db.get_file(&t, &hash).expect("get"), None);
        call(&mut db, json!({"op":"commit","token":token}));
    }
    std::fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn upgrades_schema_v1_in_place() {
    let dir = std::env::temp_dir().join(format!("mavyn-v1-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join("library.sqlite3");
    {
        let connection = rusqlite::Connection::open(&path).expect("v1");
        connection.execute_batch("CREATE TABLE records(store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(store,key)) WITHOUT ROWID;
            CREATE INDEX revisions_by_document ON records(json_extract(value,'$.documentId')) WHERE store='revisions';
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE VIRTUAL TABLE search_index USING fts5(document_id UNINDEXED,title,body,tokenize='unicode61 remove_diacritics 2',prefix='2 3 4');
            INSERT INTO records VALUES('settings','k','{\"key\":\"k\",\"value\":1}');
            INSERT INTO records VALUES('documents','d','{\"id\":\"d\",\"contentHash\":\"head\"}');
            INSERT INTO records VALUES('contents','head','{\"hash\":\"head\",\"text\":\"now\"}');
            INSERT INTO records VALUES('contents','old','{\"hash\":\"old\",\"text\":\"before\"}');
            INSERT INTO records VALUES('revisions','r1','{\"id\":\"r1\",\"documentId\":\"d\",\"contentHash\":\"old\"}');
            PRAGMA user_version=1;").expect("seed v1");
    }
    let mut db = LocalStore::open(&path).expect("upgrade");
    let token = call(
        &mut db,
        json!({"op":"begin","mode":"readonly","stores":["settings","files","contents"]}),
    );
    // v3: history is gone, and so is the text only an old revision referenced.
    assert_eq!(
        call(
            &mut db,
            json!({"op":"all","token":token,"store":"contents"})
        ),
        json!([{"hash":"head","text":"now"}])
    );
    assert_eq!(
        call(
            &mut db,
            json!({"op":"get","token":token,"store":"settings","key":"k"})
        )["value"],
        1
    );
    assert_eq!(
        call(&mut db, json!({"op":"all","token":token,"store":"files"})),
        json!([])
    );
    call(&mut db, json!({"op":"commit","token":token}));
    drop(db);
    let version: i64 = rusqlite::Connection::open(&path)
        .expect("open")
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .expect("version");
    assert_eq!(version, 3);
    let connection = rusqlite::Connection::open(&path).expect("open");
    let leftovers: i64 = connection
        .query_row(
            "SELECT count(*) FROM records WHERE store='revisions'",
            [],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(leftovers, 0);
    let index: i64 = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='revisions_by_document'",
            [],
            |r| r.get(0),
        )
        .expect("index");
    assert_eq!(index, 0);
    std::fs::remove_dir_all(dir).expect("cleanup");
}
