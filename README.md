# Mavyn

Local-first Markdown reader, editor and library with an optional self-hosted sync server.
English and Russian interface.

> **Status:** early development. See [docs/status.md](docs/status.md) for exactly what works and
> what has been verified on which platform. Nothing here is released yet.

## What works today

- Web app / PWA: library in IndexedDB, reader, CodeMirror editor, split view, autosave, undo/redo
  that survives autosave, version history with diff and restore.
- Clicking a task checkbox in reading mode changes exactly that `[ ]` in the source (no text
  matching), keeps CRLF/LF and all other bytes intact, and refuses stale edits.
- GFM, footnotes, emoji, math (KaTeX), Mermaid, callouts, Shiki highlighting, sanitized raw HTML.
- Search across documents (Russian and English, case/`ё` folding, prefix matching).
- Light/dark/system theme, accent color, reading preferences; instant en ↔ ru switching.
- API server (Rust/Axum/PostgreSQL): setup-token bootstrap, login sessions, libraries with
  roles, documents with compare-and-swap revisions, idempotent writes, change feed, search.
- Sync between the web app and the server it is served from: offline-first, automatic merging of
  non-overlapping edits, conflict resolution UI (keep mine / use server / keep both).

Not yet: desktop/Android sync and builds verified on real systems, SQLite store, attachments,
PDF export beyond the browser's print dialog. See the status page.

## Quick start (development)

Requires Node.js ≥ 22.12.

```bash
npm install
npm run dev:web        # http://localhost:5173
npm test               # unit + integration tests (Vitest)
npm run typecheck
```

Server tests need Docker (they run Rust and PostgreSQL in containers): see
[docs/testing.md](docs/testing.md).

## Self-hosting

```bash
cp infrastructure/docker/.env.example infrastructure/docker/.env   # set POSTGRES_PASSWORD
docker compose -f infrastructure/docker/compose.yaml up -d --build
docker compose -f infrastructure/docker/compose.yaml logs server | grep "setup token"
```

Details, HTTPS reverse proxy and backups: [docs/deployment.md](docs/deployment.md).

## Documentation

| Audience | Documents |
|---|---|
| Users | [English guide](docs/user/en.md) · [Руководство на русском](docs/user/ru.md) |
| Operators | [Deployment](docs/deployment.md) · [Security](docs/security.md) |
| Developers | [AGENTS.md](AGENTS.md) · [Architecture](docs/architecture.md) · [Plan](docs/plan.md) · [API](docs/api.md) · [Testing](docs/testing.md) · [Contributing](docs/contributing.md) |
