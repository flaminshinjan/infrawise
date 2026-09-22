#!/usr/bin/env bash
# kill -9 recovery demo.
#
# Preconditions: redis + emulators running, server running (pnpm dev or
# pnpm --filter @lab/server dev), at least one active session (use the web UI
# or `pnpm demo` in another terminal to create load first).
#
# What it shows:
#   1. SIGKILL the server process (no shutdown hooks run).
#   2. Restart it.
#   3. Reconciliation adopts orphaned sessions into the reconnect grace window,
#      kills orphan capture processes, and the reaper expires sessions whose
#      clients never return; devices are cleaned before reallocation.
set -euo pipefail
cd "$(dirname "$0")/.."

pid=$(pgrep -f "tsx.*apps/server|tsx watch src/index.ts" | head -1 || true)
if [ -z "$pid" ]; then
  echo "server process not found; start it first (pnpm --filter @lab/server dev)" >&2
  exit 1
fi

echo "== state before kill:"
curl -s http://127.0.0.1:4000/api/v1/devices | python3 -m json.tool | grep -E '"id"|"state"' || true

echo ""
echo "== kill -9 $pid"
kill -9 "$pid"
sleep 1

echo "== restarting server"
export PATH="/opt/homebrew/share/android-commandlinetools/platform-tools:$PATH"
(pnpm --filter @lab/server dev > .emulator-logs/server-restarted.log 2>&1 &)

echo "== waiting for readiness"
for i in $(seq 1 30); do
  if curl -s -m 2 http://127.0.0.1:4000/api/v1/readyz | grep -q '"ok":true'; then
    echo "server ready after restart"
    break
  fi
  sleep 1
done

echo ""
echo "== recovery events (watch DISCONNECTED -> grace -> expiry -> cleanup -> reallocation):"
sleep 2
curl -s "http://127.0.0.1:4000/api/v1/events?count=20" | python3 -m json.tool | grep -E '"type"|"deviceId"|"sessionId"' | head -40

echo ""
echo "Done. Watch the UI: an open tab reconnects within the 15s grace and keeps"
echo "its session; a closed tab's session expires, the device cleans, and the"
echo "queue advances. Poll /api/v1/events for the full transition log."
