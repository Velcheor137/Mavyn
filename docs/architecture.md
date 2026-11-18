# Architecture

Status: living document. Decisions marked **ADR** are binding until explicitly replaced.

## 1. Goals and non-goals

Goals: local-first Markdown reader/editor/library with optional self-hosted sync; Windows, Linux,
Android (Tauri 2), web/PWA; first-class English and Russian.

Non-goals: real-time character-level co-editing (no CRDT), proprietary file formats, a separate
search service. Release automation is documented separately in `docs/releases.md`.

## 2. Layering

```
 apps/web (PWA)      apps/desktop (Tauri 2: Windows/Linux/Android)      apps/server (Axum)
      │                       │                                               │
      └─────── packages/ui (React components, layouts, screens) ──┐           │
                     │                                            │           │
   packages/editor (CodeMirror 6)   packages/markdown-engine      │           │
                     │                     │                      │           │
              packages/core (domain models, services, merge) ─────┘           │
                     │                                                        │
   packages/storage (contracts + IndexedDB / memory adapters)                 │
   packages/platform (PlatformAdapter: files, secure storage, OS)             │
   packages/sync-client (outbox, change-feed client) ── HTTP ── crates/sync-protocol
   packages/i18n (en, ru catalogs; error-code → message)         crates/domain, crates/shared-types
```

Rules:

- `packages/ui` never imports Tauri, IndexedDB, `fetch`, or SQL. It receives services through a
  React context (`AppServices`) built by each app entry point.
- `packages/core` and `packages/markdown-engine` are pure TypeScript, DOM-free, and run in Node
  for tests and in Web Workers.
- `apps/web` must run without any Tauri API. `apps/desktop` adds a `TauriPlatformAdapter`.
- The Rust crates `domain` (roles, error codes) and `sync-protocol` (wire types) are shared by the
  server and the Tauri shell. A separate `shared-types` crate was dropped as redundant. Wire types
  will be mirrored in TypeScript in `packages/sync-client` with JSON fixtures checked by both sides
  (not implemented yet).

## 3. Platform boundaries (ADR-001)

| Concern | Web/PWA | Desktop (Win/Linux) | Android |
|---|---|---|---|
| Managed storage | IndexedDB (documents, contents, files, sync bases) | SQLite in app data dir through Rust local-store | Same SQLite engine, verified in Android 16 x86_64 emulator; physical ARM64 pending |
| Linked files | File System Access API where available (Chromium); otherwise import-only + "save as" download | Real paths via Rust commands, atomic save | SAF `content://` URIs with persisted permissions; copy/save-as fallback |
| Full-text search | In-memory inverted index built in a worker from IndexedDB, persisted per identity | SQLite FTS5 (`unicode61 remove_diacritics 2`) + prefix queries | same as desktop |
| Secrets | HttpOnly cookie session; nothing in JS storage | Windows Credential Manager; Linux native sync pending | Android Keystore AES-GCM, encrypted files excluded from backup |
| File associations | `launch_handler`/`file_handlers` in manifest (Chromium only) | NSIS/MSI associations, XDG `.desktop` MimeType | System picker; VIEW/SEND/SEND_MULTIPLE managed copies with bounded durable mailbox |

Capabilities are exposed as flags on `PlatformAdapter.capabilities`, and the UI hides or degrades
features accordingly instead of failing at call time.

## 4. Domain model

All IDs are UUIDv7 (time-ordered, generated client-side so offline creation is possible).

```
Library   { id, name, kind: local|server, serverId?, createdAt }
Folder    { id, libraryId, parentId?, name, sortKey, deletedAt? }
Document  { id, libraryId, folderId?, title, fileName, kind?: text|file, mime?, encoding?, bom,
            source: Imported|Linked{locator,fingerprint}, contentHash, originalHash?,
            importBytesHash?, tags[], favorite, updatedAt, deletedAt?, remote? }
Content   { hash, text }                  -- current text of text documents (sha-256 of UTF-8)
FileRow   { hash, size, bytes }           -- bytes of binary documents and originals of import
Tag       { name (NFC, casefolded key), displayName }
OutboxOp  { opId (UUIDv7), kind, entityId, baseRevisionId?, payload, attempts, nextAttemptAt }
SyncState { libraryId, cursor, status: Synced|Pending|Syncing|Offline|Conflict|Error, lastError? }
```

Binary documents (ADR-007): `DocumentMeta.kind = 'file'` with `mime` marks a docx, xlsx, ods or
pdf. Absent `kind` means text, so older records need no migration. Bytes are content-addressed in a
separate `files` store; `readContent`/`saveContent` refuse them (`document.not_text`), `readFile` and
`saveFile` (compare-and-swap on the hash) handle them. docx, xlsx and ods are edited in Mavyn, pdf is
view-only. `originalHash` keeps the bytes the document was imported with. A rename keeps the type's
extension. Import checks name, size (≤ 50 MiB), signature and, for zip-based formats, the central
directory (`inspectZip`: entry count, unpacked size and ratio) before anything is parsed — the same
checks run on bytes downloaded by sync.

Text documents of any kind (ADR-009): `textFormat(fileName)` decides how a text document is shown —
Markdown names (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`) get the reader and editor, everything
else (plain text, code, logs, `.txt`) only the source editor with syntax highlighting by file name;
CSV/TSV also get a table view. Import accepts any file whose content is text (`detectText`: BOM,
strict UTF-8, otherwise statistical detection with `chardet`; NUL bytes mean binary). The text is a
JS string, stored and synced as UTF-8 and hashed as UTF-8; `encoding` (WHATWG label, absent = UTF-8)
and `bom` say how bytes are written back (`encodeText`: UTF-8/16 directly, single-byte encodings
through a reverse table built from `TextDecoder`, two-byte CJK encodings likewise; characters the
encoding cannot represent fail with `file.unencodable`, never silently replaced). A non-UTF-8 import
keeps its original bytes (`importBytesHash`) until the first edit so "Reopen with encoding" works.
Text documents may be up to 256 MiB.

Text invariants:

- Document content is stored byte-for-byte as loaded. Line endings (LF/CRLF/mixed) and BOM are
  preserved; the editor works on the decoded string and writes back the same line-ending style.
- `contentHash` is computed over the exact stored bytes.
- Names/tags compare by `NFC` + locale-insensitive casefold (`toLocaleLowerCase('und')`); display
  keeps user input.

No version history (ADR-008, replaces ADR-002): a document keeps only its current content. A save
replaces the content row and deletes the previous one unless another document (or an original of
import) still uses it. Undo/redo lives in the open editor only. Synced text keeps one hidden base
(`syncBases`) for three-way merges; it is not user-visible history. Upgrades delete existing
revisions: IndexedDB v4 drops the `revisions` store, SQLite schema v3 deletes the revision records,
the server's migration 0004 drops the `revisions` table — each also deletes contents only an old
revision referenced. Without history some safety nets are explicit instead: "use server version"
warns that local text is discarded, and a linked file changed both on disk and in Mavyn keeps the
Mavyn text as a copy before the disk version wins.

## 5. Markdown pipeline (ADR-003)

`markdown-engine` exposes three layers:

1. `parse(source, profile)` → mdast with `position.start/end.offset` (micromark + remark-gfm,
   remark-math, remark-frontmatter, directive-based callouts and GitHub `> [!NOTE]` callouts).
2. `toHast(mdast, options)` → hast with `data-src-start/end` attributes on block elements (for
   preview↔source navigation) and `data-task-offset` on task checkboxes.
3. Sanitization with `rehype-sanitize` using an explicit allow-list schema (no `script`, `style`
   attributes, event handlers, `iframe`, `object`, `embed`, `form`; URLs restricted to
   `http`, `https`, `mailto`, `#`, relative; `data:` only for raster images when the profile allows).
   Math (KaTeX) and Mermaid run **after** sanitization on their own trusted output; Mermaid uses
   `securityLevel: 'strict'` and its SVG is rendered into an isolated container.

Profiles: `commonmark`, `gfm`, `extended` (default: gfm + math + footnotes + frontmatter + callouts
+ mermaid). Unknown syntax is never rewritten because saves always write the source text, never
re-serialised mdast or HTML.

### Task checkbox editing (ADR-004)

A task list item in source looks like `<indent><marker> [ ]` where the marker is `-`, `*`, `+`,
`1.` or `1)`. During `toHast`, for every `listItem` with `checked !== null`, the engine locates the
exact offset of the character between the brackets by scanning from `listItem.position.start.offset`
past the marker and whitespace (this is deterministic; label text is never used). The checkbox gets
`data-task-offset=<n>`, and the parse also returns the source revision (content hash) it was built
from.

`toggleTask(source, offset, expectedHash)`:

1. Rejects with `stale_revision` if `hash(source) !== expectedHash` — caller re-renders.
2. Verifies `source[offset-1] === '['`, `source[offset+1] === ']'`, and `source[offset]` ∈ `{' ', 'x', 'X'}`;
   otherwise `marker_mismatch`.
3. Returns a single-character `TextEdit { from: offset, to: offset+1, insert }`.

The edit is applied as a CodeMirror transaction when the editor is open (so it joins undo history
and composes with concurrent edits) or to the working copy otherwise; both paths go through the same
`DocumentSession.applyEdits()` so undo/redo works across autosave.

## 6. Storage and saving

Native managed storage (`crates/local-store`, independent Cargo workspace): bundled SQLite in
`<app_data_dir>/library.sqlite3`, WAL, synchronous FULL, schema `user_version=3` (v2 added binary
files, v3 removed version history). Fixed store/key JSON records preserve the existing domain model.
FTS5 indexes the first 4 Mi characters of each text (the in-memory web index does the same; snippets
are computed from that prefix, a whole 256 MiB log never crosses IPC) and uses `unicode61 remove_diacritics 2`, prefix indexes, NFC/case/ё folding and
quoted AND-prefix queries; refresh happens in the same transaction as document/content writes.
Native search returns only bounded matching candidates; it does not build the JS library index.

`NativeBackend` receives an injected transport, with no Tauri dependency in shared packages.
The only IPC entry is `local_store`: scoped begin/get/all/put/delete/commit/rollback,
search and migration status/marker operations. Rust chooses the path; callers cannot execute
arbitrary SQL. Transactions have opaque UUID tokens, readonly enforcement and a 60-second idle
lease. The native StoreHost runs a weak-reference background reaper so an abandoned transaction
releases its file lock without another frontend request. SQLite rolls back on connection loss.

On first start, a consistent readonly snapshot of the legacy webview IndexedDB library is
copied into an empty native database in one SQLite transaction, together with an internal
completion marker. The source database remains intact as a backup. Failed imports roll back
and can retry. A nonempty native database without a migration marker is treated as an explicit
conflict, never overwritten or merged implicitly. The one-time snapshot currently needs memory
proportional to the old database; large migration budgets remain unmeasured.

Native (Rust): atomic save = write `name.tmp-<uuid>` in the same directory → `fsync` → rename over
original (`std::fs::rename`) → `fsync` directory (Unix). Before saving a linked file, the
stored content hash is compared even when mtime/size are unchanged; mismatch → `external_change` conflict, never
overwrite. Android SAF uses a private URI allow-list plus persisted OS read/write grants.
Linked saving verifies the current SHA256, opens a non-truncating `rw` descriptor, checks
its hash again, requires a regular seekable file and probes truncation at the existing length
before writing/truncating/fsync. Unsupported providers get a localized export-copy explanation.
Export uses `ACTION_CREATE_DOCUMENT` with the appropriate MIME type. SAF writes cannot offer
universal atomic replacement or exclusion of another writer after the final hash check.

Web: managed docs in IndexedDB (`documents`, `contents` by hash, `files`, `syncBases`, `settings`),
one database per identity (`mdreader:<serverId>:<userId>` or `mdreader:local`). Linked files via
File System Access handles stored in IndexedDB; permission is re-requested on use.

Binary documents on native storage live in table `files(hash, size, bytes BLOB)` (schema v2,
additive migration from v1) outside the JSON records; `put_file` verifies the SHA-256. Bytes cross
IPC as raw payloads (`local_store_file`, `tauri::ipc::Request`/`Response`), never as JSON/base64;
operation, transaction token and hash travel in headers and use the same scoped transactions. FTS5
indexes such documents by title and file name only. On the web they are an IndexedDB object store
(database version 4). On desktop, picked files, linked reads/writes and "save as" also move raw
bytes (`take_transfer` tokens, raw request bodies with base64-JSON arguments in `x-mavyn-args`); the
Android plugin bridge is JSON-only, so Android still sends file bytes as base64.

Linked files: text, code and docx/xlsx/ods can be linked to a file on disk (pdf is always a copy).
Saves write the file first (hash-checked compare-and-swap), then the library; on open a file changed
on disk wins, an edit made only in Mavyn (e.g. synced) is written to the file.

## 7. Server (ADR-005)

Axum + Tokio + SQLx (PostgreSQL 15+; compose pins 15.13). Versioned REST under `/api/v1`. Errors are
`{ "error": { "code": "document.not_found", "details": {…} } }`; clients map codes to localized
messages (`packages/i18n/src/locales/*/errors.json`).

Auth: username/password, Argon2id (m=19 MiB, t=2, p=1 per OWASP), opaque random session tokens
(32 bytes) stored hashed (SHA-256) in `sessions`; browser uses `__Host-session` cookie
(Secure, HttpOnly, SameSite=Lax) plus double-submit CSRF token for unsafe methods and strict Origin
check; native clients use `Authorization: Bearer`. Bootstrap: when no users exist, the server
prints a one-time setup token to the log and `/api/v1/setup` requires it; no default credentials.

Authorization: `library_members(library_id, user_id, role)` with role ∈ owner > admin > editor >
viewer. Folders/documents inherit their library's ACL (folder-level overrides are a later
extension; the check function already takes the resource path). Every handler resolves the
resource's library first and calls `authz::require(role)`; object IDs from the client are never
trusted without that lookup (IDOR protection). 404 is returned for resources the user cannot see.

Limits: text documents up to 256 MiB (`MAX_DOCUMENT_BYTES`; body limit on the create and content
routes only, 1 MiB elsewhere), binary documents 50 MiB (`MAX_FILE_BYTES`, on the file routes only);
per-IP and per-user rate limits on auth endpoints. Server search indexes the first 256 KiB of a text
(PostgreSQL caps a tsvector at 1 MiB). Client filenames never touch the filesystem.

### Binary documents (ADR-007, revised for stage 2)

docx, xlsx, ods and pdf are stored in a library as **file documents** (`documents.kind = 'file'`,
`documents.mime`) and synced through the server. docx, xlsx and ods are **edited in Mavyn** with
built-in editors; pdf stays view-only.

- **Whole-file updates, no merge.** `PUT /documents/{id}/file?base_revision_id=&sha256=` replaces the
  bytes (compare-and-swap on the head, `409 sync.conflict` otherwise). Bytes are never merged: a file
  edited on two devices is a conflict the user resolves (open the other version read-only, keep mine,
  take theirs, keep both).
- **No history, but an original.** `original_hash` keeps the bytes of the upload; `GET
  /documents/{id}/original` returns them and "Restore original" opens them as a copy. Replaced bytes
  are deleted once nothing references them.
- **Search by title only.** The `search` vector of a file is built from its title; bytes are never
  indexed.
- **Validated on every write.** Declared sha-256 must match (`file.hash_mismatch`), the MIME type must
  be on the allow-list and the bytes must start with its signature (`file.unsupported`), size ≤
  `MAX_FILE_BYTES` (`file.too_large`). The server never parses the files.
- **Served inert.** Downloads are always `application/octet-stream` with `nosniff`.
- **Stored in PostgreSQL**, `file_blobs(hash, size, mime, bytes bytea)`, content-addressed like
  `blobs`: one backup target, blob and document row in one transaction.
- **Integrity without a foreign key.** `documents.content_hash` points into `blobs` (text) or
  `file_blobs` (files) by kind; a foreign key cannot target two tables, so triggers reject a hash
  with no blob of the document's kind (and an `original_hash` with no file blob). Blob garbage
  collection (`drop_blob_if_unreferenced`) locks the blob row first and checks references in a new
  statement; writers lock it with `INSERT … ON CONFLICT DO UPDATE`, so a concurrent reference is
  either seen or re-inserts the row.
- **Protocol 2.** Clients of protocol 1 (v0.1.x) treated files as immutable and are refused
  (`sync.protocol_unsupported`); the stage-1 `files=1` opt-in is gone.

**Editors.** Spreadsheets (`packages/ui/src/sheets`): one model for xlsx (ExcelJS, the loaded
workbook is patched on save so page setup, defined names and theme survive), ods (own reader/writer;
untouched cells are written back as their original XML, other package parts byte for byte) and
CSV/TSV (text documents with a table view; cells are exact text). Formulas are recalculated with
HyperFormula (GPLv3 — Mavyn is GPLv3 because of it); inserting/deleting rows and columns goes through
it so references move. Word (`packages/ui/src/docx`): ProseMirror over `word/document.xml` only;
every block parsed from the file keeps its original XML and is written back byte for byte while
untouched, edited paragraphs are regenerated from the model plus their original properties, unknown
inline content (fields, bookmarks, equations, shapes) are atoms that keep their XML. Styles,
numbering, headers and footers stay as they are; lists, images and tables add what they need (media,
relationships, content types, list definitions). Content an editor cannot keep — charts, pivot
tables, macros, embedded objects, comments, tracked changes, functions HyperFormula lacks — makes the
first edit go to a copy (`forkWithEdits`), the original stays untouched. Autosave writes whole files
after 3 s without changes (at most every 30 s while editing); sync uploads an edited file after it
has been quiet for 30 s.

## 8. Sync protocol (ADR-006)

Implemented in `packages/sync-client` (engine + HTTP client) against the server API in
`docs/api.md`.

**Mapping.** A device syncs one server library with one local folder (created with the library's
name). Every document in that folder is synced; each synced document carries a `RemoteRef`
(`serverId`, `libraryId`, `baseRevisionId`, `baseHash`, `conflict`). The last text known to be
identical on the server is kept in the `syncBases` store as the common ancestor for merges.

**No separate outbox.** A document is pending when `contentHash !== remote.baseHash` (or it has
no base yet, or it is trashed with a base). Local edits are durable before any network call, so
the "queue" survives crashes by construction. Idempotency keys are derived deterministically
(`sha256(op|doc|base|hash)` formatted as UUIDv8), so a retry after a lost response replays the
stored server response instead of creating a second revision.

**Pull.** `GET /libraries/{id}/changes?cursor=` pages through upserts and tombstones ordered by a
server sequence; the cursor is saved after each page. For each changed document: unknown → create
locally; unmodified local copy → fast-forward; modified → three-way merge (`diff3` on lines) with
the stored base; clean → merged text becomes pending on top of the new head; not clean → the
document is marked `conflict` and neither side is overwritten. Tombstones trash unmodified copies;
modified copies are detached and kept as local documents. A remote edit of a locally trashed
document restores it.

**Push.** Creates (`POST` with the client UUID), compare-and-swap updates (`PUT` with
`base_revision_id`), deletes. `409 sync.conflict` → fetch head, integrate as in pull, retry.
`404` on update → access lost or deleted: keep the text locally, detached.

**Conflict resolution** (UI banner): keep mine (upload on top of their head), use server (the local
text is discarded — there is no history, the banner says so and shows the diff first), keep both
(server version stays, local text moves to a new local document). Merges of very large texts
(base + ours + theirs above 24 Mi characters) are not attempted; they go to the banner.

**Scheduling.** Sync runs on start, 1.5 s after local changes, every 60 s, on `online` and when the
tab becomes visible. Network/5xx failures back off exponentially with full jitter (1 s … 5 min);
auth and access errors stop and are shown to the user. Status: Synced / Pending / Syncing /
Offline / Conflict / Error.

**Identity.** The web app syncs only with the server it is served from (HttpOnly cookie; the CSRF
token is read from `/auth/me`, never stored). A saved connection is used only when the signed-in
user matches. Signing out detaches synced copies and optionally deletes them; documents with
unsent changes are always kept.

**Revoked access.** `library.not_found` stops syncing with an error; local copies remain and can
be exported. Offline copies cannot be erased remotely — the UI states this.

**Deviation from the original plan:** per-identity IndexedDB databases were replaced by
per-document `RemoteRef`s in one local database, so synced and local documents share one library
UI. Android and Windows reuse this engine through a restricted native HTTP client. The configured
server is an HTTPS origin (loopback-only HTTP for development), redirects are refused, requests
are limited to protocol routes, and login bearer tokens are stored in the OS vault before a
redacted response reaches JavaScript. Credentials are scoped by a hash of the canonical origin;
saved mappings must match both server URL and user. Logout drains sync/conflict operations
before detaching copies and clearing credentials. Native startup retries an unavailable configured
server. Linux native sync remains unavailable until a secure credential backend is implemented.

**Binary documents.** Created with `POST /libraries/{id}/files`, edited with `PUT
/documents/{id}/file` (base revision, `sha256`, deterministic idempotency key), downloaded with `GET
…/file` and verified (hash, type) before storing; a new device also downloads the original of import.
A file changed on the server while unchanged here is replaced; changed on both sides it becomes a
conflict (never merged). Edited files are uploaded only after 30 s without local saves. Windows and
Android route these requests through the restricted native client as raw bytes (`native_sync_file`,
POST/PUT bodies, reply framed as u16 status + body; 600 s timeout). Large JSON bodies (text up to 256
MiB) get the same timeout.

**Text encodings.** `encoding` travels with text documents (create, change feed, `PATCH` with
`base_encoding`/`encoding` compare-and-swap like the name).

## 9. Security boundaries

- All Markdown is untrusted (§5). Rendered HTML is inserted only after sanitization.
- Resource resolution: relative images resolve against the document's own directory/library;
  `..` escaping the library root is refused. Desktop exposes local images via a scoped Tauri asset
  protocol limited to the document's directory, never arbitrary paths. Remote images: HTTPS only,
  loaded by the client (the server never fetches user-provided URLs → no SSRF surface).
- CSP (web): `default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'`
  (`unsafe-inline` for KaTeX/Shiki inline styles); `script-src 'self'`; `frame-ancestors 'none'`.
- Binary documents are parsed only in the client and only by their viewers, after `detectFileType`.
  docx renders with docx-preview into a detached tree that is cleaned (no scripts, iframes, forms,
  event handlers, non-`data:`/`blob:` images; links only http/https/mailto, opened externally;
  altChunk HTML never rendered) and then placed in a shadow root. Spreadsheets are read by SheetJS
  without formulas, HTML or VBA and rendered by React from cell text, never `sheet_to_html`.
  PDF uses pdf.js ≥ 4.2.67 (CVE-2024-4367) without XFA or the scripting sandbox.
- QR connection codes contain only `{ "v":1, "url": "https://…", "name": "…" }`.

## 10. Localization

`packages/i18n` uses i18next with resources bundled per locale and namespaces `common`, `settings`,
`errors`, `sync`. Keys are typed via a generated `Resources` declaration from the `en` catalog; a
Vitest test enforces `en`/`ru` key parity, identical interpolation variables, and all Russian plural
forms (`_one`, `_few`, `_many`, `_other`). Dates/numbers use `Intl.*` with the active locale.

## 11. Known constraints of the current dev environment

See `docs/status.md` for what has actually been built and verified, and on which platforms.
