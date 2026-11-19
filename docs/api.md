# HTTP API (`/api/v1`)

JSON over HTTPS. Wire types: `crates/sync-protocol/src/lib.rs`.

**Authentication.** Native clients send `Authorization: Bearer <token>` from `POST /auth/login`.
Browsers use the HttpOnly `__Host-mdr_session` cookie set by login; unsafe methods then also need
`X-CSRF-Token: <csrf_token from login>` and, when `PUBLIC_ORIGIN` is configured, a matching
`Origin`. Scripts and MCP clients use an **API key** (`Authorization: Bearer mvn_…`, see
[API keys](#api-keys)); keys need no CSRF token.

**Errors.** `{"error": {"code": "<stable code>", "details": {…}}}`. Clients localize by code
(`crates/domain/src/lib.rs` → `codes`). Resources in libraries you are not a member of answer
`404 library.not_found` / `document.not_found` (no existence leaks).

**Idempotency.** `POST /libraries/{id}/documents`, `POST /libraries/{id}/files`,
`PUT /documents/{id}/content` and `PUT /documents/{id}/file` accept `Idempotency-Key: <uuid>`; a
retry with the same key returns the original response.

**Documents.** Every document object (`DocumentInfo`) carries `kind` (`"text"` or `"file"`), `mime`
(`null` for text), `encoding` (file encoding of a text document, `null` for UTF-8) and
`original_hash` (files: SHA-256 of the bytes they were imported with; `null` for text). There is no
version history (ADR-008): `head_revision_id` is only the compare-and-swap version token, and a
replaced text or file is deleted on the server once nothing references it. Text documents are any
text (Markdown, plain text, code, logs; content always UTF-8) up to `MAX_DOCUMENT_BYTES` (256 MiB by
default); search indexes the first 256 KiB of each. Files (docx, xlsx, ods, pdf; ADR-007) are
searched by title only and replaced as a whole (`PUT …/file`), never merged.

**Protocol version.** Optional `X-Sync-Protocol: 2`; other values (including `1`, the v0.1.x clients
that treated files as immutable) → `400 sync.protocol_unsupported` with `details.supported`.

| Method & path | Role | Description |
|---|---|---|
| `GET /health` | — | `{"status":"ok","protocol":2}` |
| `GET /setup` | — | `{"needs_setup": bool}` |
| `POST /setup` | setup token | `{token, username, password}` → first admin (once) |
| `POST /auth/login` | — | `{username, password, device_name?}` → `{token, csrf_token, user}`; rate limited |
| `POST /auth/logout` | any | Revokes the current session |
| `GET /auth/me` | any | Current user plus the session's `csrf_token` (browsers read it here) |
| `GET /auth/sessions` | any | Own active sessions |
| `DELETE /auth/sessions/{id}` | any | Revoke one of own sessions |
| `POST /users` | server admin | Create a user |
| `GET /tokens` | server admin (session) | Own API keys that are still valid (never the key itself) |
| `POST /tokens` | server admin (session) | `{name, access: "read"\|"write", can_delete, all_libraries, library_ids, expires_in_days: 30\|90\|365\|null}` → `201 {token, info}`; the key is shown only here |
| `DELETE /tokens/{id}` | server admin (session) | Revoke one of own keys; it stops working at once |
| `GET /libraries` | any | Libraries with the caller's role |
| `POST /libraries` | any | `{name}`; caller becomes owner |
| `GET /libraries/{id}/members` | viewer | Members |
| `PUT /libraries/{id}/members` | admin | `{username, role}`; only owners grant admin/owner |
| `DELETE /libraries/{id}/members/{user}` | admin (or self) | The last owner cannot be removed |
| `GET /libraries/{id}/documents` | viewer | Live documents (text and files) |
| `POST /libraries/{id}/documents` | editor | `{id (client UUIDv7), file_name, content, folder_id?, encoding?}` |
| `POST /libraries/{id}/files?id=&file_name=&folder_id=&sha256=&mime=` | editor | Raw body (`application/octet-stream`) → `201 DocumentInfo` of a file document; see below |
| `POST /libraries/{id}/folders` | editor | `{id (client UUIDv7), parent_id, name}` |
| `GET /folders/{id}` | viewer | Folder name and parent |
| `PATCH /folders/{id}` | editor | Rename/move `{base_name, base_parent_id, name, parent_id}`, field-wise compare-and-swap; moves below itself are ignored |
| `DELETE /folders/{id}` | editor | Soft-deletes the folder, its subfolders and their documents |
| `GET /libraries/{id}/changes?cursor=&limit=` | viewer | Change feed incl. tombstones: `{documents, folders, cursor, has_more}` |
| `GET /libraries/{id}/search?q=` | viewer | Prefix full-text search; snippets mark matches with `⟦…⟧`; files by title only |
| `GET /documents/{id}` | viewer | Metadata + content; `409 document.not_text` for files |
| `GET /documents/{id}/info` | viewer | Metadata of any document (text or file) without content: `head_revision_id`, `mime`, … |
| `GET /documents/{id}/file` | viewer | Current file bytes: `Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff`, `Content-Length`; `409 document.not_file` for text |
| `PUT /documents/{id}/file?base_revision_id=&sha256=` | editor | Raw body: new bytes of an edited file (same checks as the upload); `409 sync.conflict` with the current head if the base is stale; `409 document.not_file` for text |
| `GET /documents/{id}/original` | viewer | The bytes the file was imported with (same headers as `…/file`) |
| `PATCH /documents/{id}` | editor | Rename/move `{base_file_name, base_folder_id, file_name, folder_id, base_encoding?, encoding?}`, field-wise compare-and-swap; titles: Markdown → first heading or name without extension, other text → file name, files → name without extension |
| `PUT /documents/{id}/content` | editor | `{base_revision_id, content, content_hash}`; `409 sync.conflict` with current head if base is stale; `409 document.not_text` for files |
| `DELETE /documents/{id}` | editor | Soft delete (tombstone) |

### File upload

`POST /libraries/{id}/files` takes the metadata in the query string (URL-encoded) and the file as
the raw body:

- `id` — client UUIDv7; an id that already exists (in any library) → `409 sync.conflict`;
- `file_name` — 1–255 bytes, no `/`, `\`, NUL; the title is the name without its extension;
- `folder_id` — optional; a missing or deleted folder puts the document at the library root;
- `sha256` — hex sha-256 of the body, which becomes `content_hash` and `original_hash`;
- `mime` — one of `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
  `application/vnd.oasis.opendocument.spreadsheet`, `application/pdf`.

The body is read only after the role check and is limited by `MAX_FILE_BYTES` (default 50 MiB), a
limit of the file routes only. `PUT /documents/{id}/file` takes `base_revision_id` and `sha256` and
applies the same checks against the document's MIME type.

| Status | Code | When |
|---|---|---|
| 400 | `request.invalid` (`details.field`: `query`, `file_name`, `sha256`, `Idempotency-Key`) | Malformed parameters |
| 400 | `file.hash_mismatch` | Body's sha-256 differs from `sha256` |
| 413 | `file.too_large` (`details.max_bytes`) | Body larger than `MAX_FILE_BYTES` |
| 415 | `file.unsupported` | `mime` not allowed, or the body lacks its signature (`PK\x03\x04` for docx/xlsx/ods, `%PDF-` for pdf) |

### Error codes of file documents

| Status | Code | When |
|---|---|---|
| 409 | `document.not_text` | `GET /documents/{id}` or `PUT …/content` on a file |
| 409 | `document.not_file` | `GET`/`PUT …/file` or `GET …/original` on a text document |
| 409 | `sync.conflict` | `PUT …/file` with a stale `base_revision_id` (`details`: `head_revision_id`, `content_hash`) |
| 400 / 413 / 415 | `file.*` | Upload validation, see above |

Removed in protocol 2: `GET /documents/{id}/revisions` (no version history) and the `files=1` opt-in
of the change feed and search.

## API keys

Server administrators create keys for themselves in the web app (Settings → API keys) or with
`POST /tokens` from a signed-in session. A key (`mvn_` + 43 characters) acts as its owner, capped by
its own scope:

- **libraries** — the chosen ones, or all of the owner's libraries including future ones; other
  libraries answer `404 library.not_found` as if they did not exist;
- **access** — `read` (at most the viewer role) or `write` (at most editor; never admin or owner,
  even when the owner is one);
- **delete** — `can_delete` (only with `write`) allows `DELETE /documents/{id}` and
  `DELETE /folders/{id}`;
- **expiry** — 30, 90 or 365 days, or none. A key also stops working when it is revoked or its
  owner is no longer a server administrator.

Keys never manage accounts, sessions, libraries, members or keys: those routes answer
`403 token.forbidden`, as do writes beyond the key's access. Each key may make 600 requests a minute
(`429 request.rate_limited`). The server stores only a SHA-256 of the key and the time it was last
used. AI clients can also use a key over MCP: see [mcp.md](mcp.md).

```bash
KEY=mvn_…; S=https://notes.example/api/v1
curl -H "Authorization: Bearer $KEY" $S/libraries
curl -H "Authorization: Bearer $KEY" "$S/libraries/$LIB/changes?limit=1000"   # folders + documents
curl -H "Authorization: Bearer $KEY" $S/documents/$DOC                        # text document
curl -H "Authorization: Bearer $KEY" -o report.xlsx $S/documents/$DOC/file    # file bytes
# upload a file
curl -H "Authorization: Bearer $KEY" -H "Content-Type: application/octet-stream" \
  --data-binary @report.xlsx \
  "$S/libraries/$LIB/files?id=$(uuidgen)&file_name=report.xlsx&sha256=$(sha256sum report.xlsx | cut -d' ' -f1)&mime=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
```

| Status | Code | When |
|---|---|---|
| 401 | `auth.required` | Unknown, revoked or expired key, or its owner is no longer an administrator |
| 403 | `token.forbidden` | Account, session, library-management or key routes; writing with a read key; deleting without `can_delete` |
| 404 | `token.not_found` | `DELETE /tokens/{id}` for a key that is not yours or already revoked |
| 429 | `request.rate_limited` | More than 600 requests a minute with one key |

Not implemented yet: attachments endpoints, blob upload by hash, QR pairing, OAuth for MCP.
