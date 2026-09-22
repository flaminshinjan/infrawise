# Assignment answers

## 1. A device frees and two waiters are at the front. What happens?

There is exactly one deterministic queue head, even when the two requests
arrived in the same millisecond: the queue is a Redis ZSET scored by enqueue
time, and equal scores order lexicographically by request id, so head-ness is
decided by data, not by timing.

A release never assigns directly. The device first moves to `CLEANING` inside
the same atomic script that makes the old session non-commandable; it is not
assignable during cleanup. After cleanup and a health check pass, the
allocator runs one Lua transaction that: pops the device from the available
set (`SPOP` — only one caller can ever receive it), skips any
cancelled/expired entries at the head, removes the oldest valid waiter,
increments the device's fencing token, creates a `RESERVED` session bound to
that fence, and maps the client to it. Because the entire transition is a
single script, competing allocator invocations cannot observe an intermediate
state — the second waiter simply becomes the new head.

The selected waiter has 10 seconds to claim (the browser claims automatically;
a reconnecting authenticated client counts as claiming). If it doesn't, the
reaper expires the reservation, the device is cleaned again and reallocated,
and the other waiter gets it. The test
`tests/allocator.integration.test.ts` hammers this with one device, ten
concurrent waiters, and eight concurrent allocator calls, asserting exactly
one owner and preserved order for everyone else.

## 2. What does "eventually served" require, and is it provided?

It is a liveness property, and it is conditional. It requires:

- a fair queue that new arrivals cannot jump (FIFO by enqueue time);
- bounded ownership: a 10-minute maximum session enforced server-side, a 10 s
  claim deadline, and a 15 s reconnect grace — so no one holds a device
  forever, cooperatively or not;
- dead waiters removed: cancelled/expired entries are skipped atomically at
  allocation time, so an invalid head can never block the queue;
- crashed owners recovered: TTL leases plus the reaper expire sessions whose
  process died, with cleanup before reassignment;
- cleanup that terminates: bounded retries, after which the device goes
  `OFFLINE` rather than wedging the pool — remaining devices keep serving;
- an allocator that runs after every capacity-creating event (release,
  cleanup completion, device recovery, new request).

Under the stated assumptions — at least one device repeatedly returns
healthy, Redis recovers from outages, and the waiter itself stays eligible —
every waiter is served in bounded position order. What it cannot promise:
service when all three devices are permanently broken, or while the
coordination store is down (during a Redis outage the system refuses new
allocations and ownership-requiring commands rather than guessing — consciously
choosing consistency over availability for ownership decisions). Those are
stated liveness assumptions, not hidden caveats. `fairness.integration.test.ts`
covers FIFO order, churn without starvation, and cancelled-head progress.

## 3. What happens when a session process is killed with `kill -9`?

Nothing graceful runs — no `finally`, no socket close handlers — and the
design assumes exactly that. The only things the dead process was doing for
correctness were renewing Redis leases (15 s TTL, renewed every 2 s) and
hosting runtime plumbing. Both are recoverable:

1. The lease stops renewing and expires.
2. The restarted server's reconciler (or, in a multi-worker deployment, any
   surviving reaper) finds the nonterminal sessions: it SIGKILLs orphaned
   capture subprocesses by their persisted pids, adopts `ACTIVE` sessions into
   `DISCONNECTED` with a fresh 15-second reconnect grace, and re-runs any
   interrupted cleanup — cleanup is idempotent precisely because the normal
   path and the recovery path may both attempt it.
3. A client that reconnects inside grace resumes the same session: same
   device, same fence, same input sequence (all durable in Redis).
4. A client that doesn't is expired by the reaper; the device transitions to
   `CLEANING` — never directly to `AVAILABLE` — is cleaned and health-checked,
   and then serves the oldest waiter under a strictly larger fencing token.
   Any delayed command still carrying the dead session's fence is rejected
   before it reaches ADB (`input-order.integration.test.ts` asserts zero
   adapter invocations for stale fences).

Observed in the fault demo on this machine: sessions become reconnectable
immediately on restart (reconciliation runs before the server accepts
traffic), and a non-returning client's device is cleaned and returned to the
pool ~20 s after restart — 15 s grace + a reaper tick + sub-second cleanup —
about 23 s total from the `kill -9` itself, dominated by the deliberately
client-friendly grace window.

## 4. What is the framerate, bottleneck, and best single improvement?

Measured numbers (see `bench-results/results.md`, reproduced in the README;
Apple Silicon host, three 720×1280 emulators, `screenrecord` H.264 → ffmpeg
MJPEG → WebSocket):

- Streaming is change-driven, so idle screens cost ~0 and FPS is measured
  under paced swiping motion: **33 FPS delivered at 1 stream, 27 FPS at 3
  streams** (≈60 FPS peak under continuous animation). Server CPU stayed
  under 3% at three streams (the transcode cost lives in the per-device
  ffmpeg/screenrecord processes).
- Tap-to-visible-change latency, measured by exploiting the change-driven
  encoder (with an idle screen, the first frame captured after an input is
  that input's visual effect): **p50 97 ms / p95 132 ms** at one stream,
  **p50 117 ms / p95 161 ms** under three-stream load (30/15 samples). This
  includes capture, encode, and transport but excludes browser decode/paint —
  an honest ~10–30 ms undercount versus true glass-to-glass.
- Input command RTT (send → ACK after `adb shell input` completes) is
  ~300 ms p50, dominated by ADB's own execution time; allocation is 11 ms.

The measured bottleneck is the capture/encode pipeline latency, not
bandwidth and not the scheduler (allocation is single-digit milliseconds and
input RTT tracks raw `adb input` latency). Specifically, screenrecord's
encoder and ffmpeg's H.264 demux/MJPEG re-encode add several hundred
milliseconds of pipeline delay before the first changed pixel reaches the
socket, and the MJPEG re-encode burns CPU per stream that scales linearly
with stream count.

Best single improvement, following that bottleneck: deliver the H.264
elementary stream directly to the browser and decode with WebCodecs, deleting
the ffmpeg re-encode entirely. It removes the transcode CPU (the linear-scaling
cost), cuts several hundred ms of buffering, and drops per-frame bytes by
roughly an order of magnitude — at the cost of keyframe-aware backpressure
(drop only up to the next IDR), which the frame header already carries the
metadata for. WebRTC would further improve congested-network behavior, but on
this measured setup the transcode hop, not the transport, is the bottleneck.
