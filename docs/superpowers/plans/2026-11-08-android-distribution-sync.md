# Android delivery and native synchronization

User instruction: proceed through all five priorities, work directly in main, no new branches.
Execute inline with superpowers:executing-plans; independent review before completion.

- [ ] Physical ARM64 phone: adb currently lists no devices. Requires USB connection and
  on-device debugging authorization by the owner. Keep this explicitly pending; emulator
  results must never be reported as physical-device results. Continue independent stages.
- [ ] Android VIEW/SEND/SEND_MULTIPLE: validate incoming content URIs/text, bounded reads,
  exact-byte managed copies, cold start and already-running delivery without lost/duplicate
  imports. Never promote temporary intent grants into writable linked-file authorization.
- [ ] Production-signing configuration and installable release APK: external keystore,
  no committed passwords/keys, stable identity/version, signature and upgrade checks,
  documented backup/restore and separate debug/release signing.
- [ ] GitHub Actions: CI, supported native packaging, guarded release aggregation/checksums,
  server container build workflow; least permissions and immutable action pins. Update the
  old phase restriction to reflect the user's explicit authorization. Do not create a public
  release tag or publish a release as part of setup.
- [ ] Android/Windows native sync: native HTTPS transport, OS-protected bearer session,
  URL/user binding, login/logout/restore, reuse existing sync engine and localized settings;
  verify against a real local server and retain offline edits and conflict protections.

Decisions: follow the existing Tauri/React/SQLite architecture; default incoming shares to
managed copies. Reuse installed SDK/NDK and Gradle. Generated outputs stay outside Git.
Use meaningful regression tests and actual UI/API evidence, and record unsupported targets
and unavailable credentials/devices without inventing successful verification.
