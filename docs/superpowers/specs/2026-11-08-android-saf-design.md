# Android local library and SAF

User priority: Android before GitHub Actions. The user delegated routine implementation decisions.

Reuse the Tauri 2 shell and SQLite engine. Add an Android-only Kotlin plugin for document
URIs, selected through ACTION_OPEN_DOCUMENT; retain read/write grants for linked files.
Import keeps a managed copy, while link requires persistent writable access. Export uses
ACTION_CREATE_DOCUMENT. No broad storage permission and no conversion of content URIs to paths.

Keep the platform adapter contract and stable error codes. Android capabilities disable
desktop printing until implemented. All bytes, BOM and line endings stay intact.
Before a linked write, read the current bytes and compare SHA256 even if size/mtime match.
Only providers supporting a seekable writable descriptor may be edited in place; otherwise
return file.unsupported so the user can save a copy. Never truncate before conflict checks.
Provider writes cannot offer a universal atomic transaction against external applications;
document this limitation rather than promising filesystem rename semantics.

Generate and retain the Android Gradle project, excluding machine paths, generated assets,
build outputs and signing material. Build ARM64 APK and x86_64 when an emulator is available.
Development APKs are explicitly debug signed; production signing/release automation is deferred.

Alternative: the existing dialog plugin uses ACTION_GET_CONTENT and does not retain SAF grants;
it cannot implement reliable linked files after restart. A separate Android app would duplicate
the UI/storage. A small native plugin preserves both the current architecture and user workflow.

Validate URI access, permissions, exact byte writes, external conflicts, cancellation and
restart persistence. Report compile checks separately from actual device/UI execution.
