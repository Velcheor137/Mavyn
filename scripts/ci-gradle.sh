#!/usr/bin/env bash
set -euo pipefail
gradle_bin=$(command -v gradle)
"$gradle_bin" --version | grep -Fx 'Gradle 9.8.2'
echo "MAVYN_GRADLE_BIN=$gradle_bin" >> "${GITHUB_ENV:?Run this preparation on a hosted Actions runner}"
