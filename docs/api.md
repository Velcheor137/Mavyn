# HTTP API (`/api/v1`)

JSON over HTTPS. Wire types: `crates/sync-protocol/src/lib.rs`.

**Authentication.** Native clients send `Authorization: Bearer <token>` from `POST /auth/login`.
Browsers use the HttpOnly `__Host-mdr_session` cookie set by login; unsafe methods then also need
`X-CSRF-Token: <csrf_token from login>` and, when `PUBLIC_ORIGIN` is configured, a matching
`Origin`.

**Errors.** `{"error": {"code": "<stable code>", "details": {…}}}`. Clients localize by code
(`crates/domain/src/lib.rs` → `codes`). Resources in libraries you are not a member of answer
`404 library.not_found` / `document.not_found` (no existence leaks).

**Idempotency.** `POST /libraries/{id}/documents` and `PUT /documents/{id}/content` accept
`Idempotency-Key: <uuid>`; a retry with the same key returns the original response.

**Protocol version.** Optional `X-Sync-Protocol: 1`; other values → `400 sync.protocol_unsupported`.

| Method & path | Role | Description |
|---|---|---|
| `GET /health` | — | `{"status":"ok","protocol":1}` |
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
| `GET /libraries/{id}/documents` | viewer | Live documents |
| `POST /libraries/{id}/documents` | editor | `{id (client UUIDv7), file_name, content, folder_id?}` |
| `GET /libraries/{id}/changes?cursor=&limit=` | viewer | Change feed incl. tombstones: `{documents, cursor, has_more}` |
| `GET /libraries/{id}/search?q=` | viewer | Prefix full-text search; snippets mark matches with `⟦…⟧` |
| `GET /documents/{id}` | viewer | Metadata + content |
| `PUT /documents/{id}/content` | editor | `{base_revision_id, content, content_hash}`; `409 sync.conflict` with current head if base is stale |
| `DELETE /documents/{id}` | editor | Soft delete (tombstone) |
| `GET /documents/{id}/revisions` | viewer | Revision history |

Not implemented yet: folders and attachments endpoints, blob upload by hash, QR pairing.
