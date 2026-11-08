# Android SAF implementation plan

> Execute inline with superpowers:executing-plans; one final independent review.

Goal: a buildable Android app with SQLite and system document open/save.
Spec: ../specs/2026-11-08-android-saf-design.md

- [x] Add adapter routing/capability tests; prove failure before implementation.
- [x] Add Android-only Kotlin plugin with URI allow-list, persisted grants, bounded reads,
      hash-checked seek/truncate writes, cancellation and create-document export.
- [x] Route shell file commands by target; retain desktop behavior and native SQLite.
- [x] Generate Android project, configure manifest/build and ignore generated outputs.
- [x] Build APK; run relevant TypeScript, Rust and Kotlin checks.
- [x] Exercise a device/emulator when available, independently review and update platform status.

Review focus: revoked/read-only grants, non-seekable providers, equal-size external changes,
cancelled pickers, restart access and desktop regressions.

Verification: 172 Vitest tests, strict TypeScript, four Gradle Kotlin tests, Windows
cross-Clippy, ARM64/x86_64 debug APKs, actual API 36 emulator SQLite/SAF UI checks.
Rulings: use API 36 (the generated template selected unavailable platform 37); retain
generated Gradle sources but ignore local/generated code and outputs; route Gradle Rust tasks
through the workspace npm script; emit 16 KB final-link flags in build.rs because the CLI
overrides target RUSTFLAGS. Physical devices, cloud providers and production signing remain
separate verification/release work. No GitHub Actions changes were made.
