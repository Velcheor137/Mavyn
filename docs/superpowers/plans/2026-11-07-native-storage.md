# Native Local Storage Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task by task.

**Goal:** Durable native SQLite library with FTS5, safe legacy migration and history maintenance.
**Architecture:** Rust local-store implements fixed-store JSON operations within tokenized
transactions; an injected TypeScript NativeBackend implements Backend. Existing Library stays
shared. Native search delegates to FTS5, while browser search retains its current implementation.
**Tech Stack:** rusqlite bundled SQLite, serde, Tauri 2, TypeScript, Vitest.
**Spec:** docs/superpowers/specs/2026-11-07-native-storage-design.md

## Global Constraints

- Exact Markdown preservation; no silent overwrites or destructive legacy migration.
- Default keep-all retention; cleanup only after explicit user action.
- English/Russian strings; web has no Tauri imports; no release/publishing work.

## Review Focus

- Abandoned/invalid tokens and readonly writes must not leave partial data (Task 1).
- Search must update on metadata/content/trash changes and safely quote query syntax (Task 1).
- Migration retries must not replace nonempty native data or erase the original (Task 2).
- Retention must preserve current/initial revisions and deduplicated contents (Task 3).
- Same-size external file edits must never be overwritten based on mtime alone (Task 4).

## Task 1 — Real SQLite engine

Files: crates/local-store/{Cargo.toml,src/lib.rs,tests/store.rs,examples/storage_bridge.rs},
Cargo.toml; packages/storage/src/{native.ts,native.test.ts,backend.ts,library.ts,search.ts}.
Interfaces: LocalStore::handle(Request)->Result<Value,StoreError>; NativeBackend(call).

- [x] Write tests for commit/reopen, rollback, token/scope checks, FTS5 en/ru and index updates.
- [x] Run tests RED, implement versioned schema, scoped tokenized transactions and search.
- [x] Add stdio JSON test bridge; run shared Library suite against the real Rust process.
- [x] Verify Rust fmt/clippy/tests and TypeScript tests/typecheck.

## Task 2 — Native integration and migration

Files: apps/desktop/src/{main.tsx,storage.ts}, src-tauri/{Cargo.toml,src/lib.rs};
packages/storage/src/{migration.ts,migration.test.ts,index.ts}; both locale catalogs.

- [x] Reproduce migration rollback and repeat-start behavior with tests.
- [x] Implement non-destructive one-time legacy import, marker and startup retry screen.
- [x] Wire the fixed database path and typed command into Tauri; no arbitrary SQL/path IPC.
- [x] Verify desktop frontend build, web build, migration tests and full suite.

## Task 3 — Explicit history maintenance

Files: packages/storage/src/{library.ts,retention.ts,library.test.ts};
packages/ui/src/components/{HistorySettings.tsx,SettingsDialog.tsx}; app.test.tsx, locale catalogs.

- [x] RED tests: retention buckets, preserve heads/imports/trash/shared content and restore kept revisions.
- [x] Implement keep-all / recent-plus-daily policy and transactional explicit cleanup.
- [x] Add localized settings/confirmation, persist policy; verify rendered UI flow.

## Task 4 — Linked saves and final validation

Files: crates/local-store/src/files.rs; desktop shell lib.rs; docs/status.md,
architecture.md, testing.md and en/ru guides.

- [x] RED filesystem test for same-size changed content with expected old hash.
- [x] Move atomic saving to tested shared native module; always compare content hash.
- [x] Run all available checks, independent review, address important findings RED→GREEN.
- [x] Commit locally and report exact platform verification and remaining Android/native limits.
