#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
source ./env.sh

for port in "${LAB_PORTS[@]}"; do
  serial="emulator-${port}"
  if adb devices | grep -q "^${serial}[[:space:]]"; then
    echo "Stopping $serial"
    adb -s "$serial" emu kill >/dev/null 2>&1 || true
  fi
done
echo "Done."
