#!/usr/bin/env bash
# Starts the three lab emulators headless and waits for full boot.
# Idempotent: skips emulators that are already running on their port.
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

mkdir -p ../.emulator-logs

for i in "${!LAB_AVDS[@]}"; do
  avd="${LAB_AVDS[$i]}"
  port="${LAB_PORTS[$i]}"
  serial="emulator-${port}"
  if adb devices | grep -q "^${serial}[[:space:]]"; then
    echo "$serial already running"
    continue
  fi
  echo "Starting $avd on port $port (headless)"
  nohup emulator -avd "$avd" -port "$port" \
    -no-window -no-audio -no-boot-anim -no-snapshot \
    -gpu swiftshader_indirect \
    > "../.emulator-logs/${avd}.log" 2>&1 &
  echo $! > "../.emulator-logs/${avd}.pid"
done

./wait-for-devices.sh
