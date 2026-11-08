# Status

Last updated: 2026-11-08. Current verification machine: Windows x64 with Ubuntu 26.04 WSL,
Node 22.23.0, Rust 1.93.1 and WebView2 157.0.4341.42. Earlier Debian/Docker results below
are inherited platform checks, not reruns on this Windows machine.

## Native storage continuation — 2026-11-08

- Desktop is now wired to `crates/local-store`: SQLite/WAL/synchronous FULL, fixed app-data
  path, versioned schema, scoped tokenized transactions and a proactive idle-lease reaper.
- FTS5 updates atomically with document/content/trash changes. Search folds NFC/case/ё,
  uses quoted AND-prefix queries and does not build a second JS text index on native.
- Legacy webview IndexedDB migration is all-or-nothing into an empty SQLite database;
  the original is retained. Interruption/retry and nonempty-destination refusal are tested.
- History settings default to keep-all. Explicit confirmed cleanup keeps 30 days of
  revisions plus daily snapshots for a year, protecting initial/head/trash/shared content.
- Both native and web linked saves always compare content hashes, including equal
  file size/mtime. This is fingerprint protection, not an exclusive lock against other apps.
- Verified on Windows + Ubuntu 26.04 WSL: Node 22.23.0 strict TypeScript, 168 Vitest
  tests (including the shared Library suite through the real Rust SQLite bridge),
  web and desktop frontend production builds. Rust 1.93.1 local-store: 10 tests,
  fmt and Clippy with warnings denied. Whole-shell Linux cargo check and Clippy passed
  with the native SQLite engine. Windows GUI verification is recorded below; no Android device test.
- One-time legacy migration currently allocates a consistent snapshot of the old database;
  memory requirements for very large libraries remain unmeasured. Android continuation and
  emulator verification are recorded below; physical-device validation remains pending.

## Android SAF continuation — 2026-11-08

- Added the Android Gradle project and an Android-only Kotlin/Rust SAF plugin. System
  document selection supports managed import and persistent read/write links; export creates
  a separate document. URI allow-list and current persisted grants are checked on each access.
  There is no broad storage permission. Desktop file commands remain in a separate module.
- Built debug-signed ARM64 and x86_64 APKs with Rust 1.93.1, JDK 21, SDK/build-tools 36,
  NDK 27.2.12479018, Gradle 9.6.1 and AGP 9.3.1. Minimum API 24, target API 36.
  Native ELF LOAD segments are 16 KB aligned. APK signature and ZIP alignment checks passed.
- Ran the x86_64 app on Android 16/API 36 in the Windows WHPX emulator: SAF import,
  Cyrillic Markdown, exact second-duplicate task edit, autosave, relaunch and SQLite audit.
  SQLite WAL/quick_check, exact content hashes, BOM/CRLF and Russian/English FTS5 were verified;
  the imported source stayed unchanged. Library state survived app and emulator restarts.
- Linked-file saving wrote the actual provider file. A retained ExternalStorageProvider grant
  allowed another write after force-stop/relaunch without reselecting the file. A same-size,
  same-mtime in-place external edit produced the conflict UI and preserved external bytes;
  loading the newer version updated SQLite/FTS5. Replacing a MediaDocumentsProvider file via
  adb revoked its grant; the app refused access instead of overwriting it.
- Fixed system-bar overlap for Android edge-to-edge rendering and included IME/cutout insets.
  Disabled desktop printing and VIEW/SEND associations on Android. Export uses format-specific
  MIME types; generic binary MIME had put collision suffixes after the Markdown extension.
  Repeated export preserved `.md` and exact bytes. Source-editor typing with the soft keyboard
  visible saved to the linked file with BOM/CRLF intact; the editor viewport stayed above the IME.
- Verification: strict TypeScript, 172 Vitest tests including the real Rust/SQLite bridge
  (`--maxWorkers 2 --testTimeout 15000` for WSL startup), four Kotlin policy tests through
  Gradle, desktop frontend build and Windows MSVC cross-Clippy. Initial bridge runs hit the
  default five-second startup limit while builds/emulation competed for host memory.
- Physical ARM64 devices, older Android versions, cloud/non-seekable providers, production
  signing, Android VIEW/SEND, print and native server sync remain unverified or unimplemented.
  SAF in-place writes are provider-dependent and cannot promise atomic replacement.
  Build/use instructions: [android.md](android.md).

## Windows native UI verification — 2026-11-08

- Cross-built the actual x64 MSVC release executable with Rust 1.93.1, cargo-xwin 0.23.1,
  LLVM and the Windows MSVC sysroot in Ubuntu WSL. Embedded the production desktop frontend
  with `tauri/custom-protocol`; no development server was used. Added the missing Windows
  ICO asset and included it in the Tauri bundle configuration.
- Ran that executable on Windows 10.0.26200 x64 with WebView2 157.0.4341.42. Used the
  isolated build identifier `app.mavyn.windows-verification`; ordinary Mavyn data was not used.
- Through the real Windows UI: native file picker/import, duplicate-label task toggle,
  CodeMirror typing/autosave, Russian `ежик` → `Ёжик` search, search for a newly typed term,
  folder creation/document move, complete app exit/relaunch, history diff and restoration.
  Folder membership, edited text and revisions survived relaunch. Restore created a third
  revision (`import`, `edit`, `restore`), preserving the edited content in history.
- Independently opened the app-created SQLite database read-only: schema v1, WAL,
  `PRAGMA quick_check = ok`, correct SHA256 content hashes, FTS5 matching current text,
  CRLF and BOM retained. The imported source file's SHA256 remained unchanged.
- Linked-file UI save wrote the real Windows file while preserving BOM/CRLF. An external
  same-size/same-mtime `Task` → `Else` edit caused the conflict banner on the next UI save;
  the external bytes were preserved. “Load newer version” loaded `Else` and updated SQLite/FTS5.
- Settings displayed the default keep-all history policy and disabled cleanup. Switching
  retention policies, destructive cleanup, large-library migration, installer/MSI/NSIS,
  file associations, signing, Windows server sync and other Windows versions remain unverified.
- Final regression checks: strict TypeScript passed, desktop frontend production build passed,
  and all 168 Vitest tests passed with the real Rust/SQLite bridge. The first run timed out
  in two bridge tests at the unchanged five-second limit; moving the bridge executable from
  the Windows-mounted filesystem to the WSL Linux filesystem made the full suite pass.
  No test timeouts or application behavior were changed for this verification.

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
| Tauri desktop — Windows | MSVC x64 release cross-build, actual Windows/WebView2 UI: import, editor/tasks, SQLite/FTS5, folders, history, restart, linked saves/conflicts | ✅ executable and local-storage UI verified · ⏳ installers/associations/signing not tested |
| Android | ARM64/x86_64 debug APKs; Android 16 x86_64 WHPX emulator, SQLite and SAF UI checks | ✅ emulator/local files · ⏳ physical devices, cloud providers, production signing |
| linux/arm64 image | — | ⏳ not built |

## Test counts

- Vitest: 172 passing with the native bridge enabled — core 22, markdown-engine 54, i18n 7,
  storage 51 (Memory + IndexedDB + real Rust/SQLite, migration), platform 5, editor 5,
  sync-client 14, ui 10, native platform 4. Without the native bridge: 154 passing and 3 migration tests skipped.
- Android SAF policy: 4 Kotlin/JUnit tests (access grants, equal-size conflicts, bounds/names, export MIME).
- Native local-store: 10 Rust tests (leases, durable storage/rollback, FTS5, migration marker,
  schema protection, linked-file saving).
- Rust: domain 3, server unit 6, API integration 10, desktop shell 1.

## Phase progress (see plan.md)

| Phase | State |
|---|---|
| 1 Foundation | Done |
| 2 Design system + localization | Done for the web app: themes, accent, reading prefs, responsive layout, full en/ru, runtime switching |
| 3 Markdown reader | Done: GFM, footnotes, emoji, math, Mermaid (zoom/pan/export SVG), callouts, Shiki, TOC, reading progress, lightbox. Relative local images: placeholder only on web |
| 4 Editor + tasks | Done: reader/source/split, exact-source checkbox edits, undo/redo across autosave, stale-edit rejection, conflict banner |
| 5 Local library | Partial: imported + linked files, nested folders, rename/move, tags/favorites/recents/trash, SQLite/FTS5 native engine, IndexedDB web store, revisions/diff/restore and explicit retention cleanup. Windows and Android emulator local-storage/SAF UI verified. Missing: physical Android devices/cloud providers and Linux GUI validation |
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

## Android delivery and distribution continuation — in progress 2026-11-08

- Android handles content-URI VIEW and SEND/SEND_MULTIPLE plus shared text as managed copies.
  A bounded app-private mailbox keeps snapshots until SQLite commits them. Stable UUIDv7 import
  IDs make retry safe without overwriting later edits. File associations use explicit text MIME
  types; no broad filesystem permission or writable link authorization is granted by an Intent.
- Verified on the Android 16 x86_64 emulator: cold/warm text shares; a separate read-only provider
  application delivering VIEW and deduplicated multiple files; Cyrillic/BOM/CRLF retained in
  SQLite. Physical ARM64 device remains unavailable in adb. Kotlin mailbox tests 3/3; strict TS
  and 173 Vitest tests, including real SQLite bridge, passed locally.
- Built release ARM64/x86_64 APKs with a separate production key. ARM64 signature, expected
  signer, non-debuggable flag, package/version and ZIP alignment verified. Actual release UI
  and upgrade validation are still in progress; this does not imply physical-phone validation.
- Added CI/release/container workflows and signing instructions. GitHub signing secrets were
  provisioned securely. Actions runtime results are pending; no public release/tag was created.
