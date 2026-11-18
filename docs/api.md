# HTTP API (`/api/v1`)

JSON over HTTPS. Wire types: `crates/sync-protocol/src/lib.rs`.

**Authentication.** Native clients send `Authorization: Bearer <token>` from `POST /auth/login`.
Browsers use the HttpOnly `__Host-mdr_session` cookie set by login; unsafe methods then also need
`X-CSRF-Token: <csrf_token from login>` and, when `PUBLIC_ORIGIN` is configured, a matching
`Origin`.

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
| `GET /libraries` | any | Libraries with the caller's role |
| `POST /libraries` | any | `{name}`; caller becomes owner |
| `GET /libraries/{id}/members` | viewer | Members |
| `PUT /libraries/{id}/members` | admin | `{username, role}`; only owners grant admin/owner |
| `DELETE /libraries/{id}/members/{user}` | admin (or self) | The last owner cannot be removed |
| `GET /libraries/{id}/documents` | viewer | Live documents (text and files) |
| `POST /libraries/{id}/documents` | editor | `{id (client UUIDv7), file_name, content, folder_id?, encoding?}` |
| `POST /libraries/{id}/files?id=&file_name=&folder_id=&sha256=&mime=` | editor | Raw body (`application/octet-stream`) → `201 DocumentInfo` of a file document; see below |
| `GET /libraries/{id}/changes?cursor=&limit=` | viewer | Change feed incl. tombstones: `{documents, folders, cursor, has_more}` |
| `GET /libraries/{id}/search?q=` | viewer | Prefix full-text search; snippets mark matches with `⟦…⟧`; files by title only |
| `GET /documents/{id}` | viewer | Metadata + content; `409 document.not_text` for files |
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

Not implemented yet: folders and attachments endpoints, blob upload by hash, QR pairing.
