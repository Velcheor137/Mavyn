# Android

The Android app reuses the React interface and Rust SQLite/FTS5 engine. The checked-in
project is `apps/desktop/src-tauri/gen/android`; machine-specific Gradle/Tauri files,
assets, native libraries, caches, outputs and keys are ignored.

## Build

Install Node from `.node-version`, a Rust toolchain, JDK 21, Android command-line tools,
SDK platform/build-tools 36 and NDK 27.2.12479018 (or a compatible newer NDK).
Set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` for your machine. Windows Rust host build
scripts also need the MSVC build tools from the Tauri prerequisites.

```sh
npm ci
rustup target add aarch64-linux-android x86_64-linux-android
npm run tauri -w @mdr/desktop -- android build --debug --apk --split-per-abi --target aarch64 x86_64
```

Use `aarch64` for ARM64 phones and `x86_64` for an emulator. APKs are under
`apps/desktop/src-tauri/gen/android/app/build/outputs/apk/`. A debug APK is installable
for development, **not a production-signed release**. Release signing and key continuity
must be configured before distribution; never commit a keystore or passwords.

Minimum Android API is 24; target/compile API is 36. Keep Android System WebView current.
The shell build script emits 16 KB ELF page-alignment flags for both 64-bit ABIs; check
the built libraries and APK rather than assuming compiler defaults provide alignment.

## Files and permissions

- **Import:** Android's system picker (`ACTION_OPEN_DOCUMENT`) reads a managed copy into
  SQLite. Editing that copy does not modify the original or require a retained grant.
- **Link:** the picker requests read/write access and retains the returned grant through
  `takePersistableUriPermission`. A private allow-list and the current OS grants must both
  authorize a URI on every subsequent read/write. No broad storage permission is requested.
- **Export:** `ACTION_CREATE_DOCUMENT` creates a new file for Markdown, HTML or other exports.
  Cancelling either picker is a normal result, not an application error.
- Bytes stay unchanged except for the requested edits, including UTF-8 BOM and CRLF.
  The bridge bounds individual files/exports to 16 MiB.
- Linked saving reads the current content and checks SHA256, then checks again through the
  writable descriptor. Equal size/time is never considered proof that a file is unchanged.
  A changed document raises the existing conflict UI; reloading reads the provider again.
- In-place saving requires a regular seekable descriptor with read/write/truncate support.
  Unsupported providers return a localized explanation to export a Markdown copy instead.
  SAF does not provide a universal atomic replace or exclusive lock: interruption during
  an accepted write and races after the final hash check remain provider-dependent.
- If access is revoked, reselect the file in the system picker or use a managed copy.
  Uninstalling clears app-private SQLite and grants; exported files remain outside the app.

Printing and Android VIEW/SEND file associations are disabled until implemented. Desktop
file commands and associations remain separate. Native server authentication/sync is pending.

## Checks

```sh
npm run typecheck
npm test
# After the Tauri CLI has generated the local plugin settings:
cd apps/desktop/src-tauri/gen/android
./gradlew :tauri-plugin-mavyn-files:testDebugUnitTest
```

The Kotlin suite covers unpicked/revoked/read-only grants, URI schemes, equal-size external
changes, file bounds and names. TypeScript tests cover native platform capabilities, exact
bytes, link/import routing and stable errors. Actual device/emulator results are recorded
separately in `docs/status.md`; compilation alone is not a device verification.

Reference: [Tauri Android prerequisites](https://v2.tauri.app/start/prerequisites/#android),
[Android document access](https://developer.android.com/training/data-storage/shared/documents-files),
[16 KB page-size support](https://developer.android.com/guide/practices/page-sizes).
