# AGENTS.md

Guidance for humans and coding agents working in this repository.

## Read first

- `docs/architecture.md` — layering, domain model, ADRs, sync protocol, security boundaries.
- `docs/plan.md` — phases and acceptance criteria.
- `docs/status.md` — what is implemented and what was *actually* verified, per platform.

## Layout

```
apps/web        Vite + React PWA entry (no Tauri imports allowed)
apps/desktop    Tauri 2 shell (Windows, Linux, Android) reusing packages/ui
apps/server     Rust Axum API (PostgreSQL)
packages/*      TypeScript libraries (npm workspaces)
crates/*        Shared Rust crates
infrastructure  Dockerfiles, compose, SQL migrations
tests           Cross-package fixtures, integration and e2e tests
```

## Commands

```bash
npm install                 # installs all workspaces
npm run typecheck           # tsc --noEmit across workspaces
npm test                    # Vitest across workspaces
npm run dev:web             # web app on http://localhost:5173
npm run build:web           # needs ~2.5 GB RAM; set NODE_OPTIONS=--max-old-space-size=2560 on small machines
docker compose -f infrastructure/docker/compose.yaml up -d --build   # server + web + postgres
```

Rust (server/crates) tests and clippy run in Docker when no host toolchain is available; see
`docs/testing.md`. ESLint is not configured yet; `tsc` strict mode and clippy `-D warnings` are
the enforced static checks.

Native storage has an independent Cargo workspace because server SQLx links a different SQLite
version. Test it with `cargo test --manifest-path crates/local-store/Cargo.toml`; see
`docs/testing.md` for the real SQLite bridge that also runs the shared TypeScript library suite.

## Rules

1. Read existing code before changing it; match its style.
2. TypeScript is `strict`; no `any`, no empty `catch`, no `@ts-ignore` without a linked reason.
3. No hardcoded user-visible strings in UI code: add keys to **both**
   `packages/i18n/src/locales/en.json` and `.../ru.json`. The parity test will fail otherwise.
   Russian plurals need `_one`, `_few`, `_many`, `_other`.
4. Never write Markdown back by serialising an AST or HTML. Edits are text edits on the source.
5. Never overwrite a file or server revision whose base you have not verified (hash/revision).
6. Server: every handler that touches a library-scoped resource calls the authz check. Return
   stable error codes, never English sentences, to clients.
7. Treat every Markdown document as hostile input. Changes to the sanitize schema need a test.
8. GitHub CI and release automation are authorized. Publishing a public release requires an
   explicit request to publish/push a version tag; never create a release tag as part of setup.
9. Do not claim a platform is verified unless it was run. Update `docs/status.md` honestly.
10. Add or update tests with each behaviour change; run typecheck + tests before declaring done.
