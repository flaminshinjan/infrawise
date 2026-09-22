#!/usr/bin/env bash
# Waits until all three lab emulators report sys.boot_completed=1.
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

deadline=$((SECONDS + 300))
for port in "${LAB_PORTS[@]}"; do
  serial="emulator-${port}"
  echo -n "Waiting for $serial to boot"
  adb -s "$serial" wait-for-device 2>/dev/null || true
  while true; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo " TIMEOUT after 300s; check .emulator-logs/" >&2
      exit 1
    fi
    booted=$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
    if [ "$booted" = "1" ]; then
      echo " booted"
      break
    fi
    echo -n "."
    sleep 2
  done
done
echo "All lab emulators booted:"
adb devices
