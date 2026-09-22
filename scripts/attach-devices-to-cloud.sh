#!/usr/bin/env bash
# Attaches this machine's three local emulators to the CLOUD deployment.
#
# Opens a chisel reverse tunnel to the shared-device-lab-tunnel Fly app and
# forwards each emulator's ADB TCP port. The cloud API then controls and
# streams the devices exactly as it would a physical device lab: same adapter,
# same scheduler, only the transport differs.
#
#   emulator adb ports (local)      tunnel machine (Fly private network)
#   127.0.0.1:5555  ------------->  [::]:15554  <- adb connect from API app
#   127.0.0.1:5557  ------------->  [::]:15556
#   127.0.0.1:5559  ------------->  [::]:15558
#
# Requires: chisel (https://github.com/jpillora/chisel) on PATH or ~/.local/bin,
# and the .tunnel-auth file created at deploy time.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"

AUTH=$(cat .tunnel-auth)
exec chisel client \
  --auth "$AUTH" \
  --keepalive 25s \
  https://shared-device-lab-tunnel.fly.dev \
  "R:[::]:15554:127.0.0.1:5555" \
  "R:[::]:15556:127.0.0.1:5557" \
  "R:[::]:15558:127.0.0.1:5559"
