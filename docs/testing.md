# Testing

## TypeScript

```bash
npm run typecheck
npm test                      # Vitest: node project (core, engine, i18n, storage) + jsdom project (editor, platform, ui)
npx vitest run packages/ui    # one package
```

Highlights:

- `packages/markdown-engine/src/tasks.test.ts` — exact-source checkbox toggling: duplicates,
  nesting, ordered/alternate markers, blockquotes, footnotes, CRLF, Unicode, 2000-task document.
- `packages/markdown-engine/src/sanitize.test.ts` — XSS payload suite checked with an HTML parser.
- `packages/editor/src/editor.test.ts` — CodeMirror ↔ session binding keeps CRLF byte-identical.
- `packages/storage/src/library.test.ts` — same suite on the memory and IndexedDB (fake-indexeddb) backends.
- `packages/ui/src/app.test.tsx` — rendered app: click checkbox → source → autosave → undo; runtime language switch.
- `packages/sync-client/src/engine.test.ts` — two devices against an in-memory server: merges,
  conflicts and resolutions, tombstones, lost responses, offline, re-linking.
- `packages/ui/src/sync.test.tsx` — sign in, pull, conflict banner, *keep both* in the rendered app.
- `packages/i18n/src/i18n.test.ts` — en/ru key parity, Russian plural forms, interpolation variables.

## Rust server (Docker, no host toolchain needed)

```bash
docker network create mdr-test
docker run -d --name mdr-test-db --network mdr-test -e POSTGRES_USER=mdr -e POSTGRES_PASSWORD=testpass postgres:15.13-bookworm
docker run --rm --network mdr-test -v "$PWD":/src -v mdr-cargo-registry:/usr/local/cargo/registry -v mdr-target:/src/target \
  -w /src -e DATABASE_URL=postgres://mdr:testpass@mdr-test-db:5432/postgres rust:1.95-bookworm \
  bash -c 'cargo test --workspace && rustup component add clippy && cargo clippy --workspace --all-targets -- -D warnings'
docker rm -f mdr-test-db && docker network rm mdr-test
```

`apps/server/tests/api.rs` uses `#[sqlx::test]`, which creates a fresh database per test.

## Manual checks

Sync against the real server: start the compose stack with `COOKIE_SECURE=false` and
`PUBLIC_ORIGIN=http://localhost:8090` in `.env`, open http://localhost:8090, create the admin with the
setup token, sign in under Settings → Server. Alternatively run the web dev server with
`MDR_API_PROXY=http://127.0.0.1:8090`.


`npm run build:web && npm run preview -w @mdr/web` serves the production build (with service worker)
at http://localhost:4173.

## Not yet automated

Playwright E2E, Tauri desktop builds, Android, accessibility audit (axe), performance budgets.
