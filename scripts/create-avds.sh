#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

for avd in "${LAB_AVDS[@]}"; do
  if avdmanager list avd -c 2>/dev/null | grep -qx "$avd"; then
    echo "AVD $avd already exists"
    continue
  fi
  echo "Creating AVD $avd"
  echo "no" | avdmanager create avd -n "$avd" -k "$LAB_SYSTEM_IMAGE" --force >/dev/null

  # Keep the lab devices small: 720x1280@320 keeps capture and encode cheap.
  config="$HOME/.android/avd/${avd}.avd/config.ini"
  {
    echo "hw.lcd.width=720"
    echo "hw.lcd.height=1280"
    echo "hw.lcd.density=320"
    echo "hw.keyboard=yes"
    echo "hw.audioInput=no"
    echo "hw.audioOutput=no"
    echo "hw.ramSize=2048"
    echo "disk.dataPartition.size=2G"
  } >> "$config"
  echo "Created $avd"
done
