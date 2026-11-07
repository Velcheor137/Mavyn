# Contributing

Read [AGENTS.md](../AGENTS.md) first: it lists the commands and the rules every change follows.

## Translations

UI strings live in `packages/i18n/src/locales/<locale>.json` (one nested catalog per language).

1. Add every new key to **all** catalogs. `npm test` fails on missing keys, mismatched
   `{{variables}}` or missing plural forms.
2. Plurals use i18next suffixes. English needs `_one`, `_other`; Russian needs `_one`, `_few`,
   `_many`, `_other` (e.g. 1 документ, 2 документа, 5 документов, 1.5 документа).
3. Never build sentences by concatenating translated fragments; use one key with interpolation.
4. Error messages are keyed by stable error codes (`errors.<code>`); the server only sends codes.

Adding a language: create `<locale>.json`, register it in `packages/i18n/src/index.ts`
(`SUPPORTED_LOCALES`, `resources`), add its plural forms to the parity test, and add a name in
`SettingsDialog.tsx` (`LOCALE_NAMES`).

## Renaming the app

The product name is a display string, kept in a few places: `app.name` in
`packages/i18n/src/locales/*.json`, `<title>` in `apps/web/index.html` and `apps/desktop/index.html`,
`apps/web/public/manifest.webmanifest`, `productName`/`identifier`/window title in
`apps/desktop/src-tauri/tauri.conf.json`, and the Compose project/image name. Internal identifiers
(IndexedDB names `mdreader:*`, cookie and storage keys, `@mdr/*` packages) deliberately stay
unchanged so existing data keeps working.

## Commits

Keep changes focused; include tests; update `docs/status.md` when you verify something on a
platform.
