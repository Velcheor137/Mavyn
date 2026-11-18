pub mod files;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;

type Result<T> = std::result::Result<T, String>;
fn sql<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|_| "storage.failed".into())
}
/// Upper bound for one binary document (docx, xlsx, ods, pdf), as in `MAX_FILE_BYTES` (TS).
pub const MAX_FILE_BYTES: usize = 50 * 1024 * 1024;
const SCHEMA_VERSION: i64 = 3;
/// Characters of a text document that go into the search index (same as the in-memory index).
const MAX_INDEXED_CHARS: usize = 4 * 1024 * 1024;

fn prefix_chars(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((end, _)) => &text[..end],
        None => text,
    }
}
/// Bytes of immutable binary documents live outside the JSON records, by SHA-256.
const FILES_TABLE: &str =
    "CREATE TABLE files(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, bytes BLOB NOT NULL) WITHOUT ROWID;";

fn fold(text: &str) -> String {
    text.nfc()
        .flat_map(char::to_lowercase)
        .map(|c| if c == 'ё' { 'е' } else { c })
        .collect()
}

#[cfg(test)]
mod lease_tests {
    use super::*;

    #[test]
    fn expired_transaction_rolls_back_and_releases_the_connection() {
        let mut store = LocalStore::open(":memory:").expect("open");
        let token = store
            .handle(json!({"op":"begin","mode":"readwrite","stores":["settings"]}))
            .expect("begin");
        store.handle(json!({"op":"put","token":token,"store":"settings","value":{"key":"pending","value":1}})).expect("put");
        store.active.as_mut().expect("active").touched = Instant::now() - Duration::from_secs(61);
        assert!(store.handle(json!({"op":"commit","token":token})).is_err());
        assert_eq!(
            store.handle(json!({"op":"status"})).expect("status")["empty"],
            true
        );
    }

    #[test]
    fn background_reaper_releases_file_lock_without_another_frontend_request() {
        let dir = std::env::temp_dir().join(format!("mavyn-reaper-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("library.sqlite3");
        let host =
            StoreHost::with_idle_timeout(path.clone(), Duration::from_millis(50)).expect("host");
        let token = host
            .handle(json!({"op":"begin","mode":"readwrite","stores":["settings"]}))
            .expect("begin");
        host.handle(json!({"op":"put","token":token,"store":"settings","value":{"key":"abandoned","value":1}})).expect("put");
        let mut other = LocalStore::open(&path).expect("second connection");
        // This connection waits for the background reaper. No more requests go to host.
        let next = other
            .handle(json!({"op":"begin","mode":"readwrite","stores":["settings"]}))
            .expect("lock released");
        assert!(other
            .handle(json!({"op":"get","token":next,"store":"settings","key":"abandoned"}))
            .expect("read")
            .is_null());
        other
            .handle(json!({"op":"commit","token":next}))
            .expect("commit");
        drop(other);
        drop(host);
        std::fs::remove_dir_all(dir).expect("cleanup");
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
enum Store {
    Documents,
    Contents,
    Folders,
    Handles,
    Settings,
    SyncBases,
    /// Binary document bytes: only `all` (hash/size listing) and `delete` go through JSON;
    /// bytes use [`LocalStore::put_file`] / [`LocalStore::get_file`].
    Files,
}
impl Store {
    fn name(self) -> &'static str {
        match self {
            Self::Documents => "documents",
            Self::Contents => "contents",
            Self::Folders => "folders",
            Self::Handles => "handles",
            Self::Settings => "settings",
            Self::SyncBases => "syncBases",
            Self::Files => "files",
        }
    }
    fn key(self) -> &'static str {
        match self {
            Self::Contents | Self::Files => "hash",
            Self::Handles | Self::SyncBases => "documentId",
            Self::Settings => "key",
            _ => "id",
        }
    }
}
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Readonly,
    Readwrite,
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Begin {
        stores: Vec<Store>,
        mode: Mode,
    },
    Get {
        token: String,
        store: Store,
        key: String,
    },
    All {
        token: String,
        store: Store,
    },
    Put {
        token: String,
        store: Store,
        value: Value,
    },
    Delete {
        token: String,
        store: Store,
        key: String,
    },
    Commit {
        token: String,
    },
    Rollback {
        token: String,
    },
    Search {
        terms: Vec<String>,
        limit: usize,
    },
    Status,
    MarkImported {
        token: String,
    },
}
struct Active {
    token: String,
    stores: HashSet<Store>,
    mode: Mode,
    touched: Instant,
}

/// One connection, no user-provided SQL or filesystem paths in the IPC protocol.
/// Every operation belongs to an explicitly scoped transaction. Abandoned transactions
/// roll back after 60 seconds of inactivity, or when the process/connection closes.
/// Native application host. The weak-reference reaper releases abandoned SQLite
/// locks even when no further IPC request reaches the original window/process.
pub struct StoreHost {
    path: PathBuf,
    database: Arc<Mutex<Option<LocalStore>>>,
    idle_timeout: Duration,
}

impl StoreHost {
    pub fn new(path: impl Into<PathBuf>) -> Result<Self> {
        Self::with_idle_timeout(path.into(), Duration::from_secs(60))
    }

    fn with_idle_timeout(path: PathBuf, idle_timeout: Duration) -> Result<Self> {
        let database: Arc<Mutex<Option<LocalStore>>> = Arc::new(Mutex::new(None));
        let weak = Arc::downgrade(&database);
        let interval = idle_timeout
            .min(Duration::from_secs(1))
            .max(Duration::from_millis(1));
        std::thread::Builder::new()
            .name("mavyn-db-lease".into())
            .spawn(move || loop {
                std::thread::sleep(interval);
                let Some(database) = weak.upgrade() else {
                    break;
                };
                let Ok(mut guard) = database.lock() else {
                    break;
                };
                if guard
                    .as_mut()
                    .is_some_and(|store| store.expire_idle().is_err())
                {
                    // Discard a failed connection; dropping it rolls back outstanding work.
                    // The next IPC operation reopens the file; old transaction tokens fail.
                    *guard = None;
                }
            })
            .map_err(|_| "storage.failed")?;
        Ok(Self {
            path,
            database,
            idle_timeout,
        })
    }

    fn with_store<R>(&self, f: impl FnOnce(&mut LocalStore) -> Result<R>) -> Result<R> {
        let mut guard = self.database.lock().map_err(|_| "storage.failed")?;
        if guard.is_none() {
            *guard = Some(LocalStore::open_with_idle_timeout(
                &self.path,
                self.idle_timeout,
            )?);
        }
        f(guard.as_mut().ok_or("storage.failed")?)
    }

    pub fn handle(&self, request: Value) -> Result<Value> {
        self.with_store(|store| store.handle(request))
    }

    pub fn put_file(&self, token: &str, hash: &str, bytes: &[u8]) -> Result<()> {
        self.with_store(|store| store.put_file(token, hash, bytes))
    }

    pub fn get_file(&self, token: &str, hash: &str) -> Result<Option<Vec<u8>>> {
        self.with_store(|store| store.get_file(token, hash))
    }
}

pub struct LocalStore {
    connection: Connection,
    active: Option<Active>,
    idle_timeout: Duration,
}
impl LocalStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_idle_timeout(path, Duration::from_secs(60))
    }

    fn open_with_idle_timeout(path: impl AsRef<Path>, idle_timeout: Duration) -> Result<Self> {
        let path = path.as_ref();
        if path != Path::new(":memory:") {
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                std::fs::create_dir_all(parent).map_err(|_| "storage.failed")?;
            }
        }
        let connection = sql(Connection::open(path))?;
        let version: i64 =
            sql(connection.pragma_query_value(None, "user_version", |row| row.get(0)))?;
        if version > SCHEMA_VERSION {
            return Err("storage.schema_unsupported".into());
        }
        sql(connection.busy_timeout(Duration::from_secs(5)))?;
        sql(connection.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        ))?;
        if version == 0 {
            let tables: i64=sql(connection.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",[],|r|r.get(0)))?;
            if tables != 0 {
                return Err("storage.schema_unsupported".into());
            }
            sql(connection.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE records(store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(store,key)) WITHOUT ROWID;
                CREATE INDEX revisions_by_document ON records(json_extract(value,'$.documentId')) WHERE store='revisions';
                CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE VIRTUAL TABLE search_index USING fts5(document_id UNINDEXED,title,body,tokenize='unicode61 remove_diacritics 2',prefix='2 3 4');
                PRAGMA user_version=1; COMMIT;"))?;
        }
        if version < 2 {
            // v2: binary documents. Additive only; existing records are untouched.
            sql(connection.execute_batch(&format!(
                "BEGIN IMMEDIATE; {FILES_TABLE} PRAGMA user_version=2; COMMIT;"
            )))?;
        }
        if version < 3 {
            // v3: no version history (ADR-008). Old revisions go, and with them every text or file
            // that no document references any more.
            sql(connection.execute_batch(
                "BEGIN IMMEDIATE;
                DELETE FROM records WHERE store='revisions';
                DROP INDEX IF EXISTS revisions_by_document;
                DELETE FROM records WHERE store='contents' AND key NOT IN
                    (SELECT json_extract(value,'$.contentHash') FROM records WHERE store='documents');
                DELETE FROM files WHERE hash NOT IN
                    (SELECT json_extract(value,'$.contentHash') FROM records WHERE store='documents');
                PRAGMA user_version=3; COMMIT;",
            ))?;
        }
        Ok(Self {
            connection,
            active: None,
            idle_timeout,
        })
    }
    pub fn handle(&mut self, value: Value) -> Result<Value> {
        let request: Request = serde_json::from_value(value).map_err(|_| "storage.failed")?;
        self.expire_idle()?;
        match request {
            Request::Begin { stores, mode } => {
                self.idle()?;
                if stores.is_empty() {
                    return Err("storage.failed".into());
                }
                sql(self.connection.execute_batch(if mode == Mode::Readwrite {
                    "BEGIN IMMEDIATE"
                } else {
                    "BEGIN"
                }))?;
                let token = uuid::Uuid::new_v4().to_string();
                self.active = Some(Active {
                    token: token.clone(),
                    stores: stores.into_iter().collect(),
                    mode,
                    touched: Instant::now(),
                });
                Ok(json!(token))
            }
            Request::Get { token, store, key } => {
                self.check(&token, Some(store), false)?;
                if store == Store::Files {
                    return Err("storage.failed".into());
                }
                Ok(self.get(store, &key)?.unwrap_or(Value::Null))
            }
            Request::All { token, store } => {
                self.check(&token, Some(store), false)?;
                if store == Store::Files {
                    let mut statement = sql(self
                        .connection
                        .prepare("SELECT hash,size FROM files ORDER BY hash"))?;
                    let rows = sql(statement.query_map([], |row| {
                        Ok(json!({"hash": row.get::<_, String>(0)?, "size": row.get::<_, i64>(1)?}))
                    }))?;
                    return Ok(Value::Array(sql(rows.collect())?));
                }
                let mut statement = sql(self
                    .connection
                    .prepare("SELECT value FROM records WHERE store=?1 ORDER BY key"))?;
                let rows = sql(statement.query_map([store.name()], |row| row.get::<_, String>(0)))?;
                self.values(rows)
            }
            Request::Put {
                token,
                store,
                value,
            } => {
                self.check(&token, Some(store), true)?;
                if store == Store::Files {
                    return Err("storage.failed".into());
                }
                let key = value
                    .get(store.key())
                    .and_then(Value::as_str)
                    .ok_or("storage.failed")?;
                sql(self.connection.execute("INSERT INTO records(store,key,value) VALUES(?1,?2,?3) ON CONFLICT(store,key) DO UPDATE SET value=excluded.value",params![store.name(),key,value.to_string()]))?;
                self.refresh(store, key)?;
                Ok(Value::Null)
            }
            Request::Delete { token, store, key } => {
                self.check(&token, Some(store), true)?;
                if store == Store::Files {
                    sql(self
                        .connection
                        .execute("DELETE FROM files WHERE hash=?1", [&key]))?;
                    return Ok(Value::Null);
                }
                sql(self.connection.execute(
                    "DELETE FROM records WHERE store=?1 AND key=?2",
                    params![store.name(), key],
                ))?;
                self.refresh(store, &key)?;
                Ok(Value::Null)
            }
            Request::Commit { token } => {
                self.check(&token, None, false)?;
                // Leave the transaction active if COMMIT fails so the caller can roll back.
                sql(self.connection.execute_batch("COMMIT"))?;
                self.active = None;
                Ok(Value::Null)
            }
            Request::Rollback { token } => {
                self.check(&token, None, false)?;
                sql(self.connection.execute_batch("ROLLBACK"))?;
                self.active = None;
                Ok(Value::Null)
            }
            Request::Status => {
                self.idle()?;
                let imported: bool = sql(self.connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM metadata WHERE key='legacyImported')",
                    [],
                    |r| r.get(0),
                ))?;
                let empty: bool = sql(self.connection.query_row(
                    "SELECT NOT EXISTS(SELECT 1 FROM records) AND NOT EXISTS(SELECT 1 FROM files)",
                    [],
                    |r| r.get(0),
                ))?;
                Ok(json!({"legacyImported":imported,"empty":empty}))
            }
            Request::MarkImported { token } => {
                self.check(&token, Some(Store::Settings), true)?;
                sql(self.connection.execute(
                    "INSERT OR REPLACE INTO metadata(key,value) VALUES('legacyImported','1')",
                    [],
                ))?;
                Ok(Value::Null)
            }
            Request::Search { terms, limit } => {
                self.idle()?;
                self.search(terms, limit)
            }
        }
    }
    /// Stores immutable document bytes under their SHA-256 inside the active write transaction.
    /// The hash is verified, so content addressing cannot be forged by the caller.
    pub fn put_file(&mut self, token: &str, hash: &str, bytes: &[u8]) -> Result<()> {
        self.expire_idle()?;
        self.check(token, Some(Store::Files), true)?;
        if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES {
            return Err("file.too_large".into());
        }
        if hex::encode(Sha256::digest(bytes)) != hash {
            return Err("storage.failed".into());
        }
        sql(self.connection.execute(
            "INSERT INTO files(hash,size,bytes) VALUES(?1,?2,?3) ON CONFLICT(hash) DO NOTHING",
            params![hash, bytes.len() as i64, bytes],
        ))?;
        Ok(())
    }

    pub fn get_file(&mut self, token: &str, hash: &str) -> Result<Option<Vec<u8>>> {
        self.expire_idle()?;
        self.check(token, Some(Store::Files), false)?;
        sql(self
            .connection
            .query_row("SELECT bytes FROM files WHERE hash=?1", [hash], |r| {
                r.get(0)
            })
            .optional())
    }

    fn expire_idle(&mut self) -> Result<()> {
        if self
            .active
            .as_ref()
            .is_some_and(|a| a.touched.elapsed() > self.idle_timeout)
        {
            sql(self.connection.execute_batch("ROLLBACK"))?;
            self.active = None;
        }
        Ok(())
    }

    fn values<T>(&self, rows: rusqlite::MappedRows<'_, T>) -> Result<Value>
    where
        T: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<String>,
    {
        let rows = sql(rows.collect::<rusqlite::Result<Vec<String>>>())?;
        Ok(Value::Array(
            rows.into_iter()
                .map(|s| serde_json::from_str(&s).map_err(|_| "storage.failed".into()))
                .collect::<Result<Vec<Value>>>()?,
        ))
    }
    fn idle(&self) -> Result<()> {
        if self.active.is_some() {
            Err("storage.busy".into())
        } else {
            Ok(())
        }
    }
    fn check(&mut self, token: &str, store: Option<Store>, write: bool) -> Result<()> {
        let active = self.active.as_mut().ok_or("storage.failed")?;
        if active.token != token
            || store.is_some_and(|s| !active.stores.contains(&s))
            || (write && active.mode != Mode::Readwrite)
        {
            return Err("storage.failed".into());
        }
        active.touched = Instant::now();
        Ok(())
    }
    fn get(&self, store: Store, key: &str) -> Result<Option<Value>> {
        let text: Option<String> = sql(self
            .connection
            .query_row(
                "SELECT value FROM records WHERE store=?1 AND key=?2",
                params![store.name(), key],
                |r| r.get(0),
            )
            .optional())?;
        text.map(|s| serde_json::from_str(&s).map_err(|_| "storage.failed".into()))
            .transpose()
    }
    fn refresh(&self, store: Store, key: &str) -> Result<()> {
        let ids = if store == Store::Documents {
            vec![key.to_owned()]
        } else if store == Store::Contents {
            let mut statement=sql(self.connection.prepare("SELECT key FROM records WHERE store='documents' AND json_extract(value,'$.contentHash')=?1"))?;
            let rows = sql(statement.query_map([key], |r| r.get::<_, String>(0)))?;
            sql(rows.collect::<rusqlite::Result<Vec<String>>>())?
        } else {
            return Ok(());
        };
        for id in ids {
            sql(self
                .connection
                .execute("DELETE FROM search_index WHERE document_id=?1", [&id]))?;
            if let Some(doc) = self.get(Store::Documents, &id)? {
                if !doc.get("deletedAt").is_none_or(Value::is_null) {
                    continue;
                }
                let title = format!(
                    "{} {}",
                    doc.get("title").and_then(Value::as_str).unwrap_or(""),
                    doc.get("fileName").and_then(Value::as_str).unwrap_or("")
                );
                if doc.get("kind").and_then(Value::as_str) == Some("file") {
                    // Binary documents are searchable by name only.
                    sql(self.connection.execute(
                        "INSERT INTO search_index(document_id,title,body) VALUES(?1,?2,'')",
                        params![id, fold(&title)],
                    ))?;
                } else if let Some(hash) = doc.get("contentHash").and_then(Value::as_str) {
                    if let Some(content) = self.get(Store::Contents, hash)? {
                        let text = content.get("text").and_then(Value::as_str).unwrap_or("");
                        // Large logs and code are searchable by their beginning only.
                        let text = prefix_chars(text, MAX_INDEXED_CHARS);
                        sql(self.connection.execute(
                            "INSERT INTO search_index(document_id,title,body) VALUES(?1,?2,?3)",
                            params![id, fold(&title), fold(text)],
                        ))?;
                    }
                }
            }
        }
        Ok(())
    }
    fn search(&self, terms: Vec<String>, limit: usize) -> Result<Value> {
        if terms.is_empty() || limit == 0 {
            return Ok(json!([]));
        }
        if terms.len() > 64 || terms.iter().any(|t| t.len() > 4096) {
            return Err("storage.failed".into());
        }
        let query = terms
            .iter()
            .filter(|s| !s.is_empty())
            .map(|term| format!("\"{}\"*", fold(term).replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        if query.is_empty() {
            return Ok(json!([]));
        }
        let mut statement=sql(self.connection.prepare("SELECT document_id,bm25(search_index,0,8,1),d.value,substr(json_extract(c.value,'$.text'),1,4194304) FROM search_index JOIN records d ON d.store='documents' AND d.key=document_id LEFT JOIN records c ON c.store='contents' AND c.key=json_extract(d.value,'$.contentHash') WHERE search_index MATCH ?1 ORDER BY bm25(search_index,0,8,1),document_id LIMIT ?2"))?;
        let rows = sql(
            statement.query_map(params![query, limit.min(100) as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            }),
        )?;
        let mut result = Vec::new();
        for row in rows {
            let (id, score, doc, content) = sql(row)?;
            let doc: Value = serde_json::from_str(&doc).map_err(|_| "storage.failed")?;
            // Only the indexed prefix goes back for snippets, never a whole 256 MiB log.
            let text = content.unwrap_or_default();
            result.push(json!({"documentId":id,"score":-score,"title":doc["title"],"text":text}));
        }
        Ok(Value::Array(result))
    }
}
