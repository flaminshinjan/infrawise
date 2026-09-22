# Shared Device Lab

Three Android emulators. Fair leases. Live control. A miniature execution
substrate for mobile QA: browser users today, agents through the same
scheduler API next, physical devices behind the same adapter after that.

**Live demo:** https://shared-device-lab-web.fly.dev (frontend, API, Redis and
device tunnel run as four separate Fly apps; devices attach from any machine
via `scripts/attach-devices-to-cloud.sh`).

> I chose Android because ADB provides the same core discovery and control
> surface for emulators and USB-connected physical devices, letting the
> scheduler, leases, input ordering, and recovery design transfer directly to
> a physical device lab. The cloud deployment already exercises exactly that
> path: the hosted scheduler controls this laptop's emulators over TCP ADB
> through a reverse tunnel, identically to how it would drive a rack of
> phones.

## Quick start

```bash
make doctor      # verifies node, pnpm, redis, adb, emulator, ffmpeg
make setup       # pnpm install + .env
make avds        # create three AVDs (one-time)
make emulators   # boot all three headless, wait for full boot
make infra       # start Redis
make dev         # server :4000, web :5173
```

Then open http://localhost:5173 in four browser windows — see
[docs/DEMO.md](docs/DEMO.md) for the full walkthrough, `make demo` for the
scripted, asserting version of the four-client flow, and `make fault-demo`
for the kill -9 recovery scenario.

## Architecture

All correctness-bearing state (queue, sessions, device ownership, fencing
tokens, leases, events) lives in Redis, and every multi-key transition is a
single Lua script — atomic allocation, atomic termination, atomic health
transitions. The Node process holds only rebuildable runtime: sockets,
capture subprocesses, input executors. Modules are separated along the seams
that would become process boundaries in a real lab: gateway, scheduler,
session service, device registry, ADB adapter (its own package, swappable for
a physical-device adapter), stream fan-out, ordered input executor, cleanup
worker, reaper, telemetry. Details in [docs/DESIGN.md](docs/DESIGN.md).

```
Browser ──HTTP/WS──▶ Gateway ─▶ Scheduler ─▶ Redis (Lua, leases, fences)
                        │                        ▲
                        ├─ Input executor        │ reaper / reconciler
                        └─ Stream fan-out ─▶ ADB adapter ─▶ 3 emulators
```

## Correctness guarantees

- **One owner per device, ever.** Allocation pops the device and binds the
  session inside one Lua script; concurrent allocators cannot double-assign
  (proven by a concurrency test hammering one device with 8 allocators).
- **FIFO with deterministic tie-breaks**; cancelled/expired heads are skipped
  atomically and can never block the queue.
- **Fencing tokens.** Every assignment increments the device fence; every
  input command re-validates ownership + fence against Redis immediately
  before touching ADB. Stale-fence commands are rejected with zero adapter
  invocations.
- **Ordered, deduplicated input.** Strict seq admission, serial execution,
  ACK after ADB completion, duplicates never re-execute, gaps reject with
  `expectedSeq`.
- **Cleanup before reassignment, always** — including after crashes; cleanup
  is idempotent and bounded, and repeated failure takes the device OFFLINE
  instead of serving it dirty.
- **kill -9 safe.** TTL leases + reaper + startup reconciliation; no shutdown
  hooks are load-bearing. Run `make fault-demo`.

## Session policy

Refresh reconnects to the same session or queue entry via an opaque token in
`sessionStorage`. Disconnects get a 15 s grace before the session expires and
the device is cleaned. Reservations must be claimed within 10 s (the browser
does this automatically). Maximum session duration is 10 minutes, enforced
server-side. All timings are env-configurable (`.env.example`).

## Streaming policy

`adb screenrecord` H.264 → one ffmpeg per device → MJPEG frames → binary
WebSocket with a 24-byte header (codec, dims, seq, fence, capture time).
**Latest-frame-wins backpressure:** a slow client holds at most one pending
frame; newer frames replace it and replaced frames are counted
(`lab_stream_frames_dropped_total`). Control messages never queue behind
video. The stream is change-driven (idle screen ≈ 0 fps, which is why FPS is
measured under motion); a one-shot screencap primes the first frame so
viewers see the screen instantly.

## Measured performance

| Metric | 1 stream | 3 streams | Test environment |
|---|---:|---:|---|
| Delivered FPS (motion) | 33.3 | 27 | Apple M5 Pro, macOS 26.6.1 |
| Encode-out->client p50* | 0 ms | 0 ms | 3x Android 14 (API 34) arm64 AVD, 720x1280@320dpi, swiftshader, headless |
| Encode-out->client p95* | 2 ms | 1 ms | same |
| Tap->visible-change p50 | 97 ms | 117 ms | 30/15 samples |
| Tap->visible-change p95 | 132 ms | 161 ms | same |
| Input RTT p50 (ADB apply) | 296 ms | 302 ms | same |
| Server CPU (median) | 1.4% | 2.7% | server process only |
| Server RSS (median) | 86 MB | 100 MB | same |
| Allocation time | 11 ms | — | request -> reservation |

\* frame timestamps are applied when ffmpeg emits the JPEG, so this column
measures server-egress to client-receive on the same host; the full
capture-to-glass cost is captured by the tap-to-visible-change rows.
Peak delivered FPS under continuous animation is ~60 (measured in earlier
unpaced runs); the table's motion pacing mimics realistic interaction, where
the change-driven stream idles between gestures. Tap-to-visible-change being
faster than input RTT is expected: the ACK waits for `adb shell input` to
finish the whole gesture, while pixels start changing as it begins.

Methodology and caveats: `scripts/benchmark.ts` (all numbers are measured by
`make benchmark`, never estimated). Tap-to-visible-change exploits the
change-driven encoder: on an idle screen, the first frame captured after an
input is that input's visual effect; the number excludes browser decode/paint
(~10–30 ms). Input RTT includes real `adb shell input` execution, which
dominates it.

**Where it falls over:** the capture→encode pipeline. `screenrecord` + the
ffmpeg H.264→MJPEG re-encode add the bulk of visible latency and the per-
stream CPU that scales linearly with stream count; ADB `input` latency
(~300 ms) bounds input responsiveness. The single highest-leverage change is
shipping the H.264 stream to the browser and decoding with WebCodecs,
deleting the re-encode hop — see
[docs/ANSWERS.md](docs/ANSWERS.md) for the full argument.

## Known limits

- Emulators are locked portrait; rotation handling exists in the mapping
  layer (unit-tested) but is not exercised end-to-end.
- `input text` supports printable ASCII only (ADB limitation) — rejected
  explicitly otherwise. Text arrives as one ordered command; paste works.
- Streaming is MJPEG over WS, not H.264/WebRTC — a deliberate 48-hour
  tradeoff, measured and documented rather than half-built.
- Single orchestrator process. The design (fences, Lua atomicity, leases)
  already tolerates multiple allocators; running them was out of scope.
- Redis outage: new allocations and ownership-requiring commands refuse
  rather than guess; active streams keep flowing.

## Docs

- [docs/ANSWERS.md](docs/ANSWERS.md) — the four assignment questions
- [docs/DESIGN.md](docs/DESIGN.md) — architecture and state machines
- [docs/DEMO.md](docs/DEMO.md) — demo walkthrough + reviewer script
- `tests/` — allocation races, FIFO/starvation, input order/fencing,
  reconnect/timeout, crash recovery, backpressure, coordinate mapping
  (35 tests; `make test`)

## Cloud deployment (Fly.io)

| App | Role |
|---|---|
| `shared-device-lab-web` | static web UI (nginx) |
| `shared-device-lab-api` | orchestrator (Node + adb + ffmpeg) |
| `shared-device-lab-redis` | private Redis with volume + auth |
| `shared-device-lab-tunnel` | chisel reverse tunnel for device attach |

`make deploy` redeploys all of them. Devices join the hosted lab from any
machine running `scripts/attach-devices-to-cloud.sh` — the same mechanism a
physical device farm would use.
