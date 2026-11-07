# Status

Last updated: 2026-11-07. Development machine: Debian 13 x86_64, Node 22.23, Docker 29;
no host Rust toolchain, no WebKitGTK, no Android SDK, ~12 GB RAM.

## Windows continuation — 2026-11-07

The Debian results below are inherited verification, not rerun on this machine.
This continuation uses Windows x64, npm 10.9.3 and a portable Node 22.23.0 runtime.
Host Rust and Docker are unavailable.

- Implemented nested folder navigation with expand/collapse, subfolder creation,
  folder rename/move, document rename/move, and English/Russian accessible dialogs.
- Folder writes now reject blank/duplicate sibling names, missing/trashed destinations
  and cycles. Validation runs inside Memory/IndexedDB transactions.
- History restore rejects a revision from another document without modifying either.
- Initial upload preserves a move made while its response is pending; enrollment
  refreshes UI metadata so open move dialogs disclose ongoing synchronization.
- Restored 41 missing optional native package records in package-lock.json without
  changing existing dependency versions. Clean npm ci now installs Windows bindings.
- The dependency Node requirement is now explicit (jsdom needs Node 22.22.2+,
  24.15.0+ or 26+); .node-version pins the tested 22.23.0 runtime.
- Verification: full Vitest suite, strict TypeScript and web production build are
  recorded for this continuation below. Native app launch, real-browser visual QA,
  Android, Rust/server integration and Docker were not tested here.

Local folder organization is not synced. Existing RemoteRefs continue syncing after
moving; local documents placed directly in the configured sync folder enroll in sync.
Filename-only rename is local metadata in the current protocol, and a later server
refresh may replace it. The heading-derived display title is unchanged by rename.

## Verification matrix

| Component | Verified how | Result |
|---|---|---|
| TypeScript packages (core, markdown-engine, i18n, storage, platform, editor, ui) | `tsc` strict + Vitest (node + jsdom) | ✅ passing (see counts below) |
| Web app production build | `vite build` | ✅ builds (main chunk 1.4 MB / 456 KB gzip — not yet split) |
| Web app in a browser | Production build in the Claude desktop built-in browser (Chromium): create document, paste content, toggle duplicate-label task, autosave, reload persistence, KaTeX, Shiki, Mermaid, table, XSS payload inert, ru auto-detected, dark theme, 375 px mobile drawer | ✅ manual check |
| Firefox / Safari | — | ⏳ not tested |
| PWA offline (service worker) | Registered in production build | ⏳ offline mode not exercised |
| First-run setup | Fresh compose stack: *Set up the server* opens automatically, wrong token / password mismatch messages, admin created, automatic sign-in, library step | ✅ manual check + UI test |
| Sync, web ↔ real server | Compose stack in the built-in browser: sign in, connect library, pull document, checkbox edit uploaded (server revision by `admin`), server-side edit of the same line → conflict banner, server diff, *keep both* and *keep mine*, sign out keeping copies, re-link without duplicates, sign out removing copies (local-only copy kept, session revoked) | ✅ manual check |
| Sync engine | 13 Vitest scenarios on an in-memory server: two devices, merge, conflicts and all resolutions, tombstones, lost responses (create/update), offline, restore on remote edit, re-linking | ✅ passing |
| Rust crates + server | `cargo test --workspace` (19 tests incl. 10 API integration tests against PostgreSQL 15.13) and `cargo clippy --all-targets -D warnings` in `rust:1.95-bookworm` | ✅ passing |
| Docker Compose stack (linux/amd64) | `docker compose up -d --build` from a clean checkout state; health checks; setup token from log → admin → login → library → Cyrillic document → search; server restart keeps data; web app + SPA fallback + security headers served | ✅ manual smoke test |
| Tauri desktop — Linux | Frontend builds; Rust shell `cargo clippy -D warnings` + `cargo test` (atomic write) in a Debian container with WebKitGTK 4.1 | ✅ compiles · ⏳ **never launched** (no display), file dialogs/associations unverified, no bundle built |
| Tauri desktop — Windows | — | ⏳ not compiled (needs Windows + WebView2) |
| Android | — | ⏳ not started (SAF adapter not implemented) |
| linux/arm64 image | — | ⏳ not built |

## Test counts

- Vitest: 143 passing — core 22, markdown-engine 54 (task offsets 10, rendering/callouts 13, sanitization 31 incl. 26 XSS payloads), i18n 7, storage 29 (memory + IndexedDB, v1→v2 upgrade), platform 4, editor 5, sync-client 14, ui 8.
- Rust: domain 3, server unit 6, API integration 10, desktop shell 1.

## Phase progress (see plan.md)

| Phase | State |
|---|---|
| 1 Foundation | Done |
| 2 Design system + localization | Done for the web app: themes, accent, reading prefs, responsive layout, full en/ru, runtime switching |
| 3 Markdown reader | Done: GFM, footnotes, emoji, math, Mermaid (zoom/pan/export SVG), callouts, Shiki, TOC, reading progress, lightbox. Relative local images: placeholder only on web |
| 4 Editor + tasks | Done: reader/source/split, exact-source checkbox edits, undo/redo across autosave, stale-edit rejection, conflict banner |
| 5 Local library | Partial: imported + linked (File System Access) files, nested folders with create/rename/move UI, document rename/move, tags, favorites, recents, trash, search, revisions/diff/restore. Missing: SQLite/FTS5 native store, Android SAF, revision retention policy |
| 6 Backend + Docker | Mostly done: auth, sessions, ACL, documents, revisions, change feed, search, compose, web sign-in. Missing: folders/attachments endpoints, user/member management UI |
| 7 Sync + offline | Web ↔ server done (one library ↔ one local folder): incremental pull, CAS push, idempotent retries, three-way merge, conflict UI, tombstones, revoked access, sign-out. Missing: desktop/Android sync (bearer token in secure storage), attachments, QR-assisted connection, offline PWA verification |
| 8 Polish | Partial: Markdown/HTML export and print stylesheet. Missing: PDF beyond print dialog, axe audit, measured performance budgets, Playwright E2E |

## Known limitations

- Markdown parsing is ~0.5 ms per line on this machine; documents ≥ 64 KB render in a Web Worker,
  but very large files (1–10 MB) were not measured.
- Search ranks by term frequency without stemming (prefix matching covers most Russian endings).
- Filename-only rename is local metadata; server-side rename synchronization remains pending.
- Sync covers document text and file names; folders inside the synced folder, tags and favorites are local only.
- The web app syncs only with the server it is served from; the dev server can proxy `/api` with `MDR_API_PROXY`.
