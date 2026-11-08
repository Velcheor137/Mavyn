#!/usr/bin/env bash
set -euo pipefail
: "${ANDROID_HOME:?Set ANDROID_HOME to the installed Android SDK}"
# Runner images expose ANDROID_HOME but do not necessarily put sdkmanager on PATH.
sdkmanager_path=$(find "$ANDROID_HOME/cmdline-tools" -type f -name sdkmanager -print -quit)
test -n "$sdkmanager_path" && test -x "$sdkmanager_path"
"$sdkmanager_path" 'platforms;android-36' 'build-tools;36.0.0' 'ndk;27.2.12479018'
