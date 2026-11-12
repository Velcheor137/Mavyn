#!/usr/bin/env bash
# Provides the Gradle that Android CI builds run (gen/android/gradlew honours MAVYN_GRADLE_BIN).
# Hosted runner images ship a preinstalled Gradle whose version changes as new images roll out,
# so it is used only when it is exactly the pinned version. Otherwise the pinned distribution is
# downloaded and verified against its published SHA-256 before use.
set -euo pipefail
version=9.8.2
sha256=21bd5da2de49b642904077f38c0efdc7778e92b3ed0889392dca61b97e389607
: "${GITHUB_ENV:?Run this preparation on a hosted Actions runner}"

gradle_bin=$(command -v gradle || true)
if [ -n "$gradle_bin" ] && "$gradle_bin" --version 2>/dev/null | grep -Fx "Gradle $version" >/dev/null; then
  echo "Using the preinstalled Gradle $version at $gradle_bin"
else
  echo "The runner's Gradle is not $version (${gradle_bin:-not installed}); installing the pinned distribution"
  dest="${RUNNER_TEMP:?Run this preparation on a hosted Actions runner}"
  archive="$dest/gradle-$version-bin.zip"
  curl -fsSL --retry 3 -o "$archive" "https://services.gradle.org/distributions/gradle-$version-bin.zip"
  echo "$sha256  $archive" | sha256sum -c -
  rm -rf "$dest/gradle-$version"
  unzip -q "$archive" -d "$dest"
  rm -f "$archive"
  gradle_bin="$dest/gradle-$version/bin/gradle"
fi
"$gradle_bin" --version | grep -Fx "Gradle $version"
echo "MAVYN_GRADLE_BIN=$gradle_bin" >> "$GITHUB_ENV"
