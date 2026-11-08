# Architecture

Status: living document. Decisions marked **ADR** are binding until explicitly replaced.

## 1. Goals and non-goals

Goals: local-first Markdown reader/editor/library with optional self-hosted sync; Windows, Linux,
Android (Tauri 2), web/PWA; first-class English and Russian.

Non-goals: real-time character-level co-editing (no CRDT), proprietary file formats, a separate
search service, release/publishing automation (handled by a later task).

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
| Managed storage | IndexedDB (documents, revisions, sync bases) | SQLite in app data dir through Rust local-store | Same SQLite engine wired; Android build/device verification pending |
| Linked files | File System Access API where available (Chromium); otherwise import-only + "save as" download | Real paths via Rust commands, atomic save | SAF `content://` URIs with persisted permissions; copy/save-as fallback |
| Full-text search | In-memory inverted index built in a worker from IndexedDB, persisted per identity | SQLite FTS5 (`unicode61 remove_diacritics 2`) + prefix queries | same as desktop |
| Secrets | HttpOnly cookie session; nothing in JS storage | OS keyring (keyring crate) | Android Keystore-backed storage |
| File associations | `launch_handler`/`file_handlers` in manifest (Chromium only) | NSIS/MSI associations, XDG `.desktop` MimeType | System picker; VIEW/SEND associations deferred |

Capabilities are exposed as flags on `PlatformAdapter.capabilities`, and the UI hides or degrades
features accordingly instead of failing at call time.

## 4. Domain model

All IDs are UUIDv7 (time-ordered, generated client-side so offline creation is possible).

```
Library   { id, name, kind: local|server, serverId?, createdAt }
Folder    { id, libraryId, parentId?, name, sortKey, deletedAt? }
Document  { id, libraryId, folderId?, title, source: Imported|Linked{locator},
            headRevisionId, contentHash, tags[], favorite, updatedAt, deletedAt? }
Revision  { id, documentId, parentRevisionId?, contentHash (sha-256 of UTF-8 bytes),
            authorId?, createdAt, size, reason: edit|import|restore|merge|conflict }
Blob      { hash, size, mime }            -- content-addressed, deduplicated (documents & attachments)
Tag       { name (NFC, casefolded key), displayName }
OutboxOp  { opId (UUIDv7), kind, entityId, baseRevisionId?, payload, attempts, nextAttemptAt }
SyncState { libraryId, cursor, status: Synced|Pending|Syncing|Offline|Conflict|Error, lastError? }
```

Text invariants:

- Document content is stored byte-for-byte as loaded. Line endings (LF/CRLF/mixed) and BOM are
  preserved; the editor works on the decoded string and writes back the same line-ending style.
- `contentHash` is computed over the exact stored bytes.
- Names/tags compare by `NFC` + locale-insensitive casefold (`toLocaleLowerCase('und')`); display
  keeps user input.

Revision grouping (ADR-002): autosave writes the working copy immediately; a new `Revision` row is
cut when (a) 5 minutes of edits have accumulated, (b) the editor is idle ≥ 60 s after changes,
(c) the document is closed, (d) before sync upload, or (e) a checkbox toggle follows a period of
no edits (toggles are coalesced over 10 s). Retention is configurable, defaulting to **keep all**.
Explicit balanced cleanup retains all versions from the last 30 days and the latest per UTC
day for a year. Initial/current revisions and all history of trashed documents stay protected.
Changing the policy does not delete anything; cleanup requires confirmation in Settings.

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
`<app_data_dir>/library.sqlite3`, WAL, synchronous FULL, schema `user_version=1`. Fixed store/key
JSON records preserve the existing domain model. A partial SQLite index accelerates revisions
by document. FTS5 uses `unicode61 remove_diacritics 2`, prefix indexes, NFC/case/ё folding and
quoted AND-prefix queries; refresh happens in the same transaction as document/content writes.
Native search returns only bounded matching candidates; it does not build the JS library index.

`NativeBackend` receives an injected transport, with no Tauri dependency in shared packages.
The only IPC entry is `local_store`: scoped begin/get/all/revisions/put/delete/commit/rollback,
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

Web: managed docs in IndexedDB (`documents`, `contents` by hash, `revisions`, `outbox`, `settings`),
one database per identity (`mdreader:<serverId>:<userId>` or `mdreader:local`). Linked files via
File System Access handles stored in IndexedDB; permission is re-requested on use.

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

Limits: body size 16 MiB for documents, 50 MiB for attachments (configurable); per-IP and per-user
rate limits on auth endpoints; uploads stored content-addressed under `DATA_DIR/blobs/ab/cd/<sha256>`
— client filenames never touch the filesystem.

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

**Conflict resolution** (UI banner): keep mine (upload on top of their head), use server (local
text stays in local history), keep both (server version stays, local text moves to a new local
document).

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
UI. The desktop app does not sync yet (needs bearer tokens in OS secure storage and CORS/native HTTP).

## 9. Security boundaries

- All Markdown is untrusted (§5). Rendered HTML is inserted only after sanitization.
- Resource resolution: relative images resolve against the document's own directory/library;
  `..` escaping the library root is refused. Desktop exposes local images via a scoped Tauri asset
  protocol limited to the document's directory, never arbitrary paths. Remote images: HTTPS only,
  loaded by the client (the server never fetches user-provided URLs → no SSRF surface).
- CSP (web): `default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'`
  (`unsafe-inline` for KaTeX/Shiki inline styles); `script-src 'self'`; `frame-ancestors 'none'`.
- QR connection codes contain only `{ "v":1, "url": "https://…", "name": "…" }`.

## 10. Localization

`packages/i18n` uses i18next with resources bundled per locale and namespaces `common`, `settings`,
`errors`, `sync`. Keys are typed via a generated `Resources` declaration from the `en` catalog; a
Vitest test enforces `en`/`ru` key parity, identical interpolation variables, and all Russian plural
forms (`_one`, `_few`, `_many`, `_other`). Dates/numbers use `Intl.*` with the active locale.

## 11. Known constraints of the current dev environment

See `docs/status.md` for what has actually been built and verified, and on which platforms.
