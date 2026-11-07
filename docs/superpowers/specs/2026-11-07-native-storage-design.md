# Native local storage

The user selected SQLite/FTS5, history and file handling and delegated implementation decisions.
Use a standalone Rust local-store crate with bundled SQLite, exposed by one typed Tauri command.
Reuse the existing TypeScript Library service and Backend transaction contract. Browser builds
continue using IndexedDB without native imports. A JS SQL plugin would duplicate transaction
coordination and expose unnecessary SQL; rewriting the Library in Rust would duplicate domain logic.

## Guarantees

- SQLite lives at the app data directory's library.sqlite3; fixed path chosen by Rust.
- Versioned schema, WAL and synchronous FULL; native transactions have opaque tokens,
  scoped stores, readonly enforcement and expiry/rollback for abandoned clients.
- Persist exact JSON domain records and text, revisions, folders, settings and sync bases.
- Incremental FTS5 indexing in the same transaction as writes, including trash/restore.
  Normalize NFC/case/ё; quoted AND-prefix queries, bounded results. No whole-library
  JS text index on native. No stemming or performance claims without measurements.
- One-time all-or-nothing IndexedDB migration into an empty SQLite store; retain original
  IndexedDB as backup and mark completion transactionally. Startup failure is localized
  and offers retry; never silently fall back to an empty library.
- Configurable history retention, default keep-all. Cleanup requires an explicit user
  action; preserve current/initial revisions, trashed documents and shared content.
- Linked file saving always checks content hash, including unchanged mtime/size, then
  uses atomic replacement. Filesystem races against unrelated processes cannot be
  eliminated by fingerprinting alone; document this boundary.
- Android SAF remains a separate platform task requiring SDK/device; no path-based
  adapter advertised as SAF. Real Tauri shell verification depends on system tooling.

## Acceptance

Real SQLite tests cover durable reopen, rollback, FTS5 ru/en/Unicode/prefix/trash, store
scope and migration rollback/retry. Run the shared Library suite through the actual Rust
bridge as well as Memory and IndexedDB. Rendered UI tests cover history policy/cleanup.
Rust fmt/clippy/tests, TS typecheck/full tests and web/desktop frontend builds must pass.
