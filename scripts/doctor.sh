#!/usr/bin/env bash
# Verifies every dependency the lab needs, with actionable messages.
set -uo pipefail
cd "$(dirname "$0")"
source ./env.sh 2>/dev/null || true

fail=0

check() {
  local name="$1" hint="$2"
  shift 2
  if "$@" >/dev/null 2>&1; then
    echo "ok    $name"
  else
    echo "MISS  $name  -> $hint"
    fail=1
  fi
}

check "node >= 20" "install from https://nodejs.org or 'brew install node'" \
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'
check "pnpm" "corepack enable && corepack prepare pnpm@9 --activate" pnpm --version
check "redis-server" "brew install redis (or use docker compose up redis)" redis-server --version
check "adb" "brew install --cask android-platform-tools" adb version
check "emulator" "brew install --cask android-commandlinetools && sdkmanager emulator" \
  test -x "$ANDROID_HOME/emulator/emulator"
check "avdmanager (needs Java)" "brew install openjdk android-commandlinetools" avdmanager list avd
check "system image android-34" "sdkmanager 'system-images;android-34;google_apis;arm64-v8a'" \
  test -d "$ANDROID_HOME/system-images/android-34/google_apis/arm64-v8a"
check "ffmpeg" "brew install ffmpeg" ffmpeg -version

if [ "$fail" -eq 1 ]; then
  echo ""
  echo "doctor: missing dependencies above; see hints."
  exit 1
fi
echo ""
echo "doctor: all dependencies present."
