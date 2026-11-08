# Builds, signing, and releases

CI runs on main and pull requests without release secrets. It checks strict TypeScript,
the web/library suite through real Rust SQLite, server PostgreSQL integration tests,
Rust formatting/Clippy, and an ARM64 Android debug build plus Kotlin tests.
Actions are pinned to immutable commits. No `pull_request_target` or PR signing job is used.

Manual dispatch of **Release** builds and verifies the complete installer/APK/checksum set
as Actions artifacts without creating or publishing a GitHub Release or container image.
Only a pushed version tag can reach the publishing job. CI and release validation have separate
concurrency groups. Android CI uses the runner's installed Gradle 9.8.2 with an explicit version
guard; local builds retain the checksum-pinned 9.6.1 wrapper or an explicit `MAVYN_GRADLE_BIN`.

## Android identity

Application ID: `app.mavyn.desktop`. Minimum Android API 24; target/compile API 36.
Build with Node from `.node-version`, Rust 1.95.0 (local Android also verified with 1.93.1),
JDK 21, SDK/build-tools 36.0.0, NDK 27.2.12479018. Install Rust target
`aarch64-linux-android`; x86_64 is useful for emulator verification.

```sh
npm ci
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
cd apps/desktop
npm run tauri -- android build --debug --apk --split-per-abi --target aarch64 --ci
```

For release builds supply `MAVYN_KEYSTORE` (absolute PKCS12 path),
`MAVYN_KEYSTORE_PASSWORD`, `MAVYN_KEY_ALIAS`, `MAVYN_KEY_PASSWORD`; omit `--debug`.
Gradle refuses release tasks without these values. Do not enable Gradle build scans or verbose
environment logging on signing runners. `scripts/verify-apk.py` checks the expected signer,
non-debuggable package, version, signature and 16 KB ZIP alignment.

Windows + WSL local helper:

```powershell
./scripts/android-signing.ps1 -Action Init
# Build the desktop frontend first using the installed Windows Node.
./scripts/android-signing.ps1 -Action Build -WslEnvironment /absolute/linux/path/to/android-env.sh -Targets aarch64
```

The local environment script sets JDK/SDK/NDK, Node and Cargo paths. The helper skips the
frontend command in WSL, passes signing passwords through environment variables and removes
the temporary private WSL keystore after building. Source keys live under
`%LOCALAPPDATA%/Mavyn/signing`, outside Git, with a restricted Windows ACL. `password.dpapi`
is decryptable by the same Windows user on the same machine. It is **not a portable backup**.

Before distributing an APK, make an owner-controlled offline backup of `release.p12` and
its password in an encrypted password manager or encrypted removable storage. A copy of only
the DPAPI file cannot recover signing on another machine. GitHub Secrets are not a recovery
backup: their values cannot be downloaded again. Never replace a lost key with a newly
generated one and describe it as an update; Android will reject that signature.

Current public signing certificate SHA-256:
`7970cde160bfe1babe6cc47e22ed67d32d2a24a51d10d37c0dad3d1f2d7def6b`.
The DER certificate is public; the private keystore/password must never be committed.

## GitHub configuration

Repository Actions Secrets:

- `MAVYN_ANDROID_KEYSTORE_BASE64`: base64 of the **same** release PKCS12 keystore.
- `MAVYN_ANDROID_KEYSTORE_PASSWORD`: store password.
- `MAVYN_ANDROID_KEY_ALIAS`: `mavyn-release` for the initialized local identity.
- `MAVYN_ANDROID_KEY_PASSWORD`: private-key password.

Repository Actions Variable `MAVYN_ANDROID_CERT_SHA256` contains the public fingerprint above.
These values were provisioned on 2026-11-08 using GitHub's sealed-box public-key API.
The keystore is restored only for tag builds and removed afterward; missing secrets fail the job.
Use GitHub-hosted ephemeral runners for releases and protect main/version tags from unreviewed writes.

## Publishing an authorized version

Creating/pushing a version tag publishes publicly. Do this only when explicitly authorized.
Set the Tauri version, update desktop package/Cargo versions as appropriate, commit, and ensure CI
is green. Android's generated versionCode must increase; `MAVYN_ANDROID_VERSION_CODE` is a local
upgrade-test override, not a way to reuse an old public version. Prerelease names also need an
increasing code before distributing multiple builds.

```sh
git tag v0.1.1
git push origin v0.1.1
```

The tag must match `apps/desktop/src-tauri/tauri.conf.json`. The release workflow validates CI,
builds Windows x64 NSIS, Linux x86_64 DEB/RPM, and signed Android ARM64 APK. Each required
artifact is uploaded under a separate job name; aggregation requires the complete set and
generates `SHA256SUMS.txt`. The GitHub Release stays draft until all uploads succeed. Tags with
`-` produce prereleases. Reruns can repair a draft, but refuse to modify a published release.
No release tag has been created by this setup task.

Windows installs may show SmartScreen/unknown publisher warnings: no trusted Windows publisher
certificate is configured. Linux bundles use Ubuntu 24.04 and WebKitGTK 4.1; older distributions
are not implied compatible. Install DEB with `sudo apt install ./Mavyn-*.deb`, RPM using the
distribution package manager. Android sideloading requires permission for the installer source.
An old debug-signed APK cannot be upgraded in place to the production signer; export local
documents before manually replacing such an installation. Normal releases preserve app data
when installed over the same package with the same signer and a compatible version code.

## Containers

After a successful package release, the reusable Docker workflow smoke-tests the actual image
and migrations with PostgreSQL, then builds amd64/arm64 and publishes
`ghcr.io/velcheor137/mavyn-server:<version>` with provenance/SBOM. There is deliberately no mutable
`latest` tag. Manual dispatch validates builds without publishing. ARM64 build uses QEMU;
runtime smoke currently exercises amd64. A container job failure is separate from the already
published application packages; rerun that job to finish the versioned image.
See [deployment.md](deployment.md) for TLS, environment, database backup and restore.

## Validation limits

Local Android signing and signature verification succeeded. Physical ARM64 phone verification,
off-machine key recovery and tag-triggered Windows/Linux packaging remain distinct checks.
See [status.md](status.md) for actual run results; YAML parsing alone is not a successful CI run.
An attempted external actionlint download was rejected by automatic tool policy; no result
from that executable is claimed.
