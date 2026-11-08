# Android delivery and native synchronization

User instruction: proceed through all five priorities, work directly in main, no new branches.
Execute inline with superpowers:executing-plans; independent review before completion.

- [ ] Physical ARM64 phone: adb currently lists no devices. Requires USB connection and
  on-device debugging authorization by the owner. Keep this explicitly pending; emulator
  results must never be reported as physical-device results. Continue independent stages.
- [x] Android VIEW/SEND/SEND_MULTIPLE: validate incoming content URIs/text, bounded reads,
  exact-byte managed copies, cold start and already-running delivery without lost/duplicate
  imports. Never promote temporary intent grants into writable linked-file authorization.
- [x] Production-signing configuration and installable release APK: external keystore,
  no committed passwords/keys, stable identity/version, signature and upgrade checks,
  documented backup/restore and separate debug/release signing.
- [x] GitHub Actions: CI, supported native packaging, guarded release aggregation/checksums,
  server container build workflow; least permissions and immutable action pins. Update the
  old phase restriction to reflect the user's explicit authorization. Do not create a public
  release tag or publish a release as part of setup.
- [x] Android/Windows native sync: native HTTPS transport, OS-protected bearer session,
  URL/user binding, login/logout/restore, reuse existing sync engine and localized settings;
  verify against a real local server and retain offline edits and conflict protections.

Decisions: follow the existing Tauri/React/SQLite architecture; default incoming shares to
managed copies. Reuse installed SDK/NDK and Gradle. Generated outputs stay outside Git.
Use meaningful regression tests and actual UI/API evidence, and record unsupported targets
and unavailable credentials/devices without inventing successful verification.

Implementation and independent verification finished on main (application/build commit
4e39c1a). CI 42488761370 passed. Manual package validation 42488762587 passed all mandatory
Windows NSIS, Linux DEB/RPM and signed Android ARM64 jobs and checksum aggregation; publication
and GHCR were skipped. No release tag was created. Actual two-way native GUI/API synchronization
ran against PostgreSQL; real offline edits survived force-stop in SQLite with their verified
remote base retained. The final Android GUI reconnect/logout check was interrupted; automatic
tool review then rejected restarting the emulator (`blocked by policy`). Do not report that
check or a physical ARM64 phone as verified. Portable signing-key backup remains owner-managed
as documented in docs/releases.md; the existing DPAPI-protected key and GitHub Secrets are not
an off-machine recovery backup.

Separate follow-up authorization: the owner explicitly requested a GitHub Release with platform
packages. Tag `v0.1.1` was pushed for tested build commit `4e39c1a`; release run 42491218576
completed every mandatory platform/checksum/publication job. The published release contains
Android ARM64 APK, Windows x64 NSIS EXE, Linux x86_64 DEB/RPM and SHA256SUMS.txt; asset digests
were verified through the GitHub API. Container jobs run as a separate subsequent stage.
