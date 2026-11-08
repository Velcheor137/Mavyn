# Security

Threat model: documents are untrusted input; servers face the internet behind TLS; clients may be
offline for long periods. Report vulnerabilities privately to the maintainers.

## Implemented and tested

| Area | Measure | Test |
|---|---|---|
| Markdown XSS | Allow-list sanitizer (no scripts, handlers, styles, iframes, SVG, forms, unsafe URL schemes); KaTeX with `trust: false` runs after sanitization; Mermaid `securityLevel: 'strict'` | `packages/markdown-engine/src/sanitize.test.ts` (26 payloads, parsed with a real HTML parser), `packages/ui/src/app.test.tsx` |
| Fake task checkboxes | Only checkboxes from Markdown task syntax with verified source offsets are interactive; edits re-check the `[ ]` marker | `tasks.test.ts`, `app.test.tsx` |
| DOM clobbering | User `id`/`name` prefixed with `user-content-` | `sanitize.test.ts` |
| Images | HTTPS only; `data:` limited to raster images; `referrerpolicy=no-referrer` | `sanitize.test.ts` |
| Data loss | Compare-and-swap saves locally (IndexedDB), on files (fingerprint) and on the server (base revision) | storage, platform, session and API tests |
| Passwords | Argon2id (19 MiB, t=2, p=1); constant work for unknown users | `crypto.rs` tests |
| Sessions | 256-bit random tokens stored as SHA-256; revocable; expiry | `login_sessions_and_revocation` |
| CSRF | Cookie requests need `X-CSRF-Token` + matching `Origin`; `SameSite=Lax`, `HttpOnly`, `Secure`, `__Host-` | `cookie_auth_requires_csrf_and_origin` |
| Brute force | Per-IP and per-username login rate limits | `login_is_rate_limited` |
| IDOR | Every library/document access resolves the library and checks membership; outsiders get 404 | `library_acl_prevents_idor_and_enforces_roles` |
| Bootstrap | One-time setup token, no default credentials | `setup_requires_token_and_runs_once` |
| Anonymous web access | The web app served by a server renders only the sign-in/setup page until `/auth/me` succeeds; expired or revoked sessions return there. The API itself rejects every unauthenticated data request | `packages/ui/src/auth.test.tsx`, API tests |
| Shared browsers | One IndexedDB library per account (`mdreader:<origin>:<userId>`); the pre-auth shared library is adopted once by the first account and then deleted | `library.test.ts` (`adoptLegacyLibrary`) |
| Injection | Parameterized SQL only; search terms reduced to letters/digits before `to_tsquery` | `search_handles_russian_english_and_hostile_input` |
| Path traversal | File names with separators rejected; server never writes client names to disk | `rejects_unsupported_protocol_and_path_tricks` |
| Headers | CSP without inline scripts, `nosniff`, `DENY` framing, `no-referrer`, `no-store` for API | `health_and_security_headers` |
| SSRF | The server never fetches user-supplied URLs (by design) | — |
| Desktop file access | Native commands only touch files the user picked/opened (persisted allow-list); atomic writes | `src-tauri` unit test (not run here, see status) |

## Known gaps

- No account lockout notifications or 2FA.
- In-memory rate limiter resets on restart and is per-instance.
- Offline copies of shared documents cannot be wiped remotely after access is revoked.
- The standalone HTML export links KaTeX CSS from jsDelivr (pinned version); offline it falls back to MathML.
