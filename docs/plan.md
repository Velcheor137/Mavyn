# Implementation plan

Each phase is done only when its acceptance criteria pass through the real UI/API, tests exist,
and `docs/status.md` records what was verified where.

## Phase 1 — Foundation

- npm-workspace monorepo, strict TS config, Vitest, ESLint, shared scripts.
- Package skeletons with real code: `core` (ids, hashing, text edits, line endings, three-way
  merge), `storage` (contracts + memory + IndexedDB adapters), `platform` (adapter contract + web
  adapter), `i18n`.
- `apps/web` boots, `apps/desktop` Tauri 2 config wired to the same UI, `apps/server` Axum skeleton
  with `/api/v1/health`.

Acceptance: `npm run typecheck && npm test` green; `npm run build:web` produces a bundle; server
image builds and `/api/v1/health` returns `{"status":"ok"}`.

## Phase 2 — Design system and localization

Acceptance: Light/Dark/System themes + accent persist without flash; sidebar/tabs/settings work on
desktop and ≤ 640 px widths; every visible string comes from i18n; switching en↔ru applies instantly
and persists; parity + plural tests green.

## Phase 3 — Markdown reader

Acceptance: CommonMark/GFM fixture suite renders; XSS fixture suite (scripts, `on*`, `javascript:`,
SVG payloads, iframes) produces no executable content; math via KaTeX; Mermaid diagrams with
syntax-error display; code highlighting + copy; TOC + reading progress; images lazy-load with
lightbox.

## Phase 4 — Editor and task interaction

Acceptance: reader/source/split modes; clicking a rendered checkbox changes exactly one source
character (tests: duplicate labels, nested, ordered markers, CRLF, Unicode, 5 MB doc); undo/redo
after autosave; stale-revision edits are rejected and re-rendered; autosave state visible.

## Phase 5 — Local library

Acceptance: import vs. link choice; folder tree, tags, favorites, recents, rename/move/trash;
search ru/en with snippets; revisions with diff and restore-as-new; desktop atomic save + external
change detection; Android SAF open/save (needs device/emulator — pending until tested).

## Phase 6 — Backend and Docker

Acceptance: setup-token bootstrap, login/logout, sessions list/revoke, libraries/folders/docs CRUD
with ACL, revisions, blobs, search; integration tests against PostgreSQL in Docker; `docker compose
up -d` brings up a healthy stack; IDOR/path traversal/oversize tests.

## Phase 7 — Sync and offline

Acceptance: first sync, offline edits, reconnect, idempotent retry, conflict → merge or conflict UI,
tombstones, revoked access; PWA works offline after first load; QR connection payload without
secrets.

## Phase 8 — Polish and validation

Acceptance: Markdown/HTML/PDF/print export; a11y audit (axe) clean on main screens; performance
budgets measured on available hardware and recorded; en/ru end-user docs complete; security review
checklist done.
