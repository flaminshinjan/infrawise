#!/usr/bin/env bash
# Give each lab emulator the real screen geometry of a distinct Pixel model, so
# the lab streams three visibly different devices. `wm size`/`wm density` change
# a running emulator instantly; screenrecord and `wm size` both report the
# override, so the API and the phone frame pick up the new dimensions with no
# AVD rebuild. Run after the emulators are booted (locally, even when the cloud
# drives them over the tunnel — the override travels with the device).
set -uo pipefail
cd "$(dirname "$0")"
source ./env.sh

# serial            resolution   density   model
profiles=(
  "emulator-5554    1080x2400    420       Pixel 8"
  "emulator-5556    1080x2340    443       Pixel 4a"
  "emulator-5558    1080x2160    443       Pixel 3"
)

for row in "${profiles[@]}"; do
  read -r serial size density model <<<"$(echo "$row" | awk '{print $1, $2, $3, $4" "$5}')"
  if ! adb devices | grep -q "^${serial}[[:space:]]"; then
    echo "skip $serial ($model): not attached"
    continue
  fi
  adb -s "$serial" shell wm size "$size" >/dev/null 2>&1
  adb -s "$serial" shell wm density "$density" >/dev/null 2>&1
  echo "$serial -> $model  $size @ ${density}dpi"
done
echo "Done. (reset any device with: adb -s <serial> shell wm size reset && wm density reset)"
