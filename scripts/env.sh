#!/usr/bin/env bash
# Shared environment for lab scripts. Sourced, not executed.
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
if [ -z "${JAVA_HOME:-}" ] && [ -d /opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home
fi
export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"

LAB_AVDS=(lab-1 lab-2 lab-3)
LAB_PORTS=(5554 5556 5558)
LAB_SYSTEM_IMAGE="system-images;android-34;google_apis;arm64-v8a"
