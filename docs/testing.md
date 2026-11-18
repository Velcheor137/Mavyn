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
- `packages/core/src/encoding.test.ts` — text detection (UTF-8/16 with and without BOM, windows-1251,
  koi8-r, Shift_JIS, binary refusal) and byte-exact writing back; `file.unencodable`; titles by format.
- `packages/ui/src/sheets/sheets.test.ts` — CSV dialects, HyperFormula recalculation and moved
  references, xlsx and ods read/edit/write (untouched styling, page setup, merges, parts byte for
  byte), unsupported parts (charts, macros).
- `packages/ui/src/docx/docx.test.ts` — untouched blocks written back byte for byte, edited paragraph
  regenerated with its properties, new images/lists/table columns, tracked changes and comments.
- `packages/sync-client/src/engine.test.ts` — also file edits on two devices with every resolution,
  originals of import on new devices, file encodings in the change feed.
- `packages/i18n/src/i18n.test.ts` — en/ru key parity, Russian plural forms, interpolation variables.

## Native SQLite and linked saving

The native engine resolves independently from server SQLx (which links a different SQLite
version), and does not need Tauri/WebKit to test:

```bash
cargo test --manifest-path crates/local-store/Cargo.toml
cargo fmt --manifest-path crates/local-store/Cargo.toml --check
cargo clippy --manifest-path crates/local-store/Cargo.toml --all-targets -- -D warnings
cargo build --manifest-path crates/local-store/Cargo.toml --example storage_bridge
```

To run the shared TypeScript Library contract against real Rust SQLite, provide the JSON
command array for the bridge. On Linux, for example:

```bash
export MAVYN_STORAGE_BRIDGE='["/absolute/path/to/Mavyn/crates/local-store/target/debug/examples/storage_bridge"]'
npm test
```

On Windows this array can launch WSL (`["wsl.exe","-d","Ubuntu","--","/mnt/c/.../storage_bridge"]`).
Without the variable the native extension and migration suite are skipped; normal web tests
still run. The test-only stdio bridge is not part of the production app or its permissions.

Coverage: commit/reopen with exact CRLF/Cyrillic/emoji; rollback and connection drop; token,
scope and readonly rejection; idle transaction reaping with two real file-backed connections;
FTS5 en/ru/prefix/trash/restore; future-schema refusal; migration retry and source preservation;
shared content; schema upgrades v1→v3 (v3 drops version history and orphaned content);
same-size/same-mtime external file edit rejection.

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
