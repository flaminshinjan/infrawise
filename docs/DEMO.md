# Demo guide

Everything below assumes `make doctor` passes. Full host setup from a fresh
clone:

```bash
make setup        # pnpm install + .env
make avds         # create the three AVDs (one-time, ~5 min incl. downloads)
make emulators    # boot all three headless and wait for full boot
make infra        # start Redis
make dev          # server on :4000, web on :5173
```

## 1. Four-client queue flow (the core demo)

Open four browser windows at http://localhost:5173 (use one normal window +
one incognito + two other browsers, or four windows — the client token lives
in `sessionStorage`, so separate windows are separate clients).

1. Click **Request a device** in windows 1–3: each gets a different emulator
   with a live stream.
2. Window 4: **Request a device** → live queue position 1.
3. Interact in any active window: tap, drag (swipe), type text via the input
   bar, Back/Home. Watch the touch indicator and input RTT.
4. Resize the window and tap the same UI element — coordinates stay accurate
   (letterbox mapping is shared code, unit-tested).
5. Refresh an active window: the session survives (same device, same fence).
6. **End session** in window 1 → watch the device clean and window 4 go
   active automatically.

Scripted version of the same flow (asserts every step):

```bash
make demo
```

## 2. Refresh / grace behavior

- Refresh: reconnects within the 15 s grace via the `sessionStorage` token —
  same session, same input sequence.
- Close a tab entirely: after 15 s the session expires, the device cleans,
  and the queue advances.

## 3. kill -9 recovery

With sessions active (UI or `make demo` paused midway):

```bash
make fault-demo
```

The script SIGKILLs the server, restarts it, and prints the event journal.
Watch: open tabs reconnect within grace and keep their sessions; a closed
tab's session expires, cleanup runs, the waiter is served with a larger
fence. Inspect `curl localhost:4000/api/v1/events` for the transition log.

## 4. Benchmarks

```bash
make benchmark    # writes bench-results/results.{json,md}
```

## 5. Cloud demo (Fly.io)

- Web: https://shared-device-lab-web.fly.dev
- API: https://shared-device-lab-api.fly.dev/api/v1/devices
- Attach this machine's emulators to the cloud lab:

```bash
./scripts/attach-devices-to-cloud.sh   # chisel reverse tunnel; keep running
```

Within ~10 s the cloud pool shows the devices AVAILABLE and the hosted UI
streams and controls them from anywhere. `make deploy` redeploys all apps.

## Reviewer script (< 5 min)

1. `adb devices` + `curl localhost:4000/api/v1/devices` — three emulators.
2. Four windows: 3 active + 1 queued (steps above).
3. Tap/swipe/type/Back/Home; resize + tap for mapping.
4. Refresh an active window — session restored.
5. End one session — cleanup event, automatic handoff to window 4.
6. `make fault-demo` — kill -9 recovery with event log.
7. `bench-results/results.md` — measured numbers and the bottleneck.
