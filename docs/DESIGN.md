# Design

## Shape of the system

The lab is a distributed ownership system with video attached. Everything that
matters for correctness — queue order, device ownership, lease fences, session
state — lives in Redis and every multi-key transition is a Lua script, so each
transition is atomic and a `kill -9` can never leave half a transition behind.
The Node process holds only runtime plumbing: WebSocket connections, capture
subprocesses, and per-session input executors — all rebuildable from Redis.

```
Browser ──HTTP/WS──▶ Gateway (Fastify)
                        │
                        ├─ Scheduler / allocator ─────┐
                        ├─ Session service            │   Redis (Lua scripts,
                        ├─ Reaper + reconciler ───────┼──▶ leases, fences,
                        ├─ Ordered input executor     │   queue, events)
                        └─ Stream producer/fan-out    │
                               │
                        Device adapter (ADB)
                        emulator-5554/5556/5558  (or TCP devices via tunnel)
```

Modules are separated in `apps/server/src/` exactly along these seams
(`scheduler/`, `input/`, `realtime/`, `api/`, `telemetry/`), with the device
adapter in its own package so a physical-device adapter can replace it without
touching queueing, leases, ordering, or telemetry.

## State machines

Device: `AVAILABLE → RESERVED → IN_USE → CLEANING → AVAILABLE`, with `OFFLINE`
reachable from anywhere health fails and recoverable only through a health
check. A device is never `AVAILABLE` while cleanup runs, and never leaves
`CLEANING` except through `finishCleanup`, which either frees it, retries, or
takes it `OFFLINE` after bounded failures.

Session: `RESERVED → ACTIVE ⇄ DISCONNECTED`, terminating through
`ENDING/EXPIRED → (cleanup) → ENDED`. Termination is atomic
(`beginTermination`): the session becomes non-commandable, the client mapping
is dropped, the lease is deleted, and the device moves to `CLEANING` in the
same script.

## Allocation

`allocate` is one Lua script: `SPOP` an available device, skip
cancelled/expired queue heads, `INCR` the device fence, create the `RESERVED`
session, bind the device, remove the waiter — one atomic step. Two allocators
racing cannot double-assign because `SPOP` hands a device to exactly one
caller and the rest of the transition happens inside the same script. The
allocator loop (`pump`) is work-conserving and coalescing: any event that can
create capacity (release, cleanup completion, device recovery, new request)
triggers it.

Reservation → activation requires a claim within 10 s. The WS client claims
automatically on receipt; a reconnecting client's authenticated connection
counts as proof of liveness and claims on its behalf. Unclaimed reservations
expire through the reaper, the device is cleaned, and allocation continues.

## Fencing

`lab:fence:{deviceId}` increments on every assignment. The fence rides on
every input command, every frame header, and the session record. The input
executor re-reads session + device from Redis immediately before each ADB call
and requires `session.state == ACTIVE`, `device.currentSessionId == sessionId`
and both fences to match — a delayed command from a dead process (or a stale
worker after reassignment) is rejected with zero adapter invocations.

## Crash recovery

Correctness never depends on shutdown hooks. Each session has a Redis lease
(`PX 15s`) renewed by the owning process every reaper tick. After `kill -9`:

1. leases stop renewing and expire;
2. on restart, reconciliation kills orphaned capture processes (pids are
   persisted per device), adopts `ACTIVE` sessions into `DISCONNECTED` with a
   fresh 15 s reconnect grace, and resumes any interrupted cleanup
   (cleanup is idempotent — both the normal worker and recovery may run it);
3. clients that reconnect inside grace resume the same session, device, fence,
   and input sequence; clients that don't are expired by the reaper, the
   device is cleaned, and the queue advances with a strictly larger fence.

## Streaming

Primary path: `adb exec-out screenrecord` (H.264) piped into one long-lived
ffmpeg per device emitting MJPEG; frames fan out as binary WS messages with a
24-byte header (codec, dims, seq, fence, capture timestamp). screenrecord is
change-driven, so idle screens cost ~0; a one-shot `screencap` primes the
first frame so a new viewer sees the screen instantly. screenrecord's 180 s
per-invocation cap is handled by restarting the adb side under one ffmpeg
(raw Annex-B segments concatenate cleanly). Fallback (`STREAM_MODE=screencap`)
is a 1–2 fps PNG loop, used automatically if screenrecord dies at startup.

Backpressure is latest-frame-wins per socket: if `bufferedAmount` exceeds the
threshold, the newest frame replaces the single pending frame and the stale
one is counted dropped. Memory per slow client is bounded at one frame.
Control messages never queue behind video — they are sent immediately on the
same socket, which stays shallow precisely because frames are dropped early.

## Ordered input

WS delivery is ordered; commands are admitted only at `lastEnqueued + 1`
(duplicates ACK `duplicate` without re-execution, gaps reject with
`expectedSeq`) and execute on a per-session serial promise chain, so ADB
execution order equals send order. ACKs fire only after ADB completes. Failed
or oversized commands still consume their sequence slot so client and server
never desync. `lastAcceptedInputSeq` persists in Redis and survives
reconnect/restart.

## Cloud deployment

Three Fly apps (`-web` static, `-api` orchestrator, `-redis` private) plus a
`-tunnel` chisel app. Devices anywhere can join the cloud lab by reverse-
forwarding their ADB TCP port through the tunnel; the API `adb connect`s them
by `host:port` serial. This is deliberately the physical-device story: the
scheduler does not know or care that today's devices are emulators on a
laptop.
