# 4-Minute Demo Video Script

A shot-by-shot script for a ~4:00 screen recording. Each section lists **[what to show]**
and *narration* (read it aloud or use as captions). Total spoken words ≈ 560 (~140 wpm).

## Before you record (2 min setup — off camera)

```bash
make emulators && make devices   # 3 Pixels booted with real profiles
make infra && make dev           # Redis + server + web
# open http://localhost:5173  (or the live site: https://shared-device-lab-web.fly.dev)
```

Have ready: **4 browser windows** side by side (call them W1–W4; use incognito/other
browsers so each has its own session token). A terminal for the `kill -9` moment.
Optional: `curl -s localhost:4000/api/v1/devices | jq` and `adb devices` in a terminal tab.

---

## 0:00 – 0:25 · Hook + what it is

**[Show the landing page. Toggle light↔dark once with the ☾/☀ button.]**

> "This is Shared Device Lab. Three real Android devices, shared over the browser. You
> lease one, drive it live, and test it by typing plain English. Under the hood it's a
> distributed ownership system — atomic leases, fencing tokens, crash recovery — with video
> attached. Let me show you."

## 0:25 – 1:05 · Lease three devices + the queue

**[W1, W2, W3: click "Request a device" one after another. Each shows a different Pixel
frame — point at the model name in the header: Pixel 8, Pixel 4a, Pixel 3.]**

> "Three windows, three requests. Each gets an exclusive lease on a *different* Pixel — an 8,
> a 4a, a 3 — with the real screen proportions. Allocation is one atomic Redis transaction,
> so two clients can never get the same device."

**[W4: click "Request a device" → show the big queue position "1 · You're next".]**

> "The pool's full, so the fourth user joins a fair FIFO queue with a live position. No
> polling, no jumping the line."

## 1:05 – 2:00 · Natural-language testing + the cursor

**[In W1's test console, type: `open settings, then swipe up, then tap the center`
Press Run. Narrate as the cursor flies to each target and the steps tick green.]**

> "Now the fun part. I type what I want — open settings, swipe up, tap the center — and the
> lab compiles it into ordered device commands. Watch the cursor physically fly across the
> screen and do each step, and the console types back what it's doing and confirms each one
> as the device acknowledges it."

**[Type a free-form one the simple parser wouldn't know, e.g.:
`scroll down a few times then open the camera` → show "Thinking…" then it runs.]**

> "If it's phrased in a way the fast parser doesn't recognize, it falls back to an LLM on the
> server — the key never touches the browser — and every generated step is re-validated
> against the same input protocol before it runs. Here it scrolls and opens the camera."

**[Quickly drag directly on the screen to show manual touch also works.]**

> "And you can always just touch the screen directly."

## 2:00 – 2:35 · Coordinate accuracy + refresh

**[Resize W1's browser window narrower/wider, then tap the same on-screen target.]**

> "Coordinates are normalized and letterbox-corrected, so a tap lands in the right place at
> any window size."

**[Refresh W1 (Cmd-R). It reconnects to the same live session.]**

> "Refresh the tab — and it reconnects to the exact same session. Your lease survives a
> refresh because the client token is persisted and the server holds the device for a
> 15-second grace window."

## 2:35 – 3:15 · Crash recovery (the money shot)

**[Terminal: show the server running. Run `make fault-demo` (or manually
`kill -9 <server pid>` then restart). Narrate over the event log it prints.]**

> "Here's the one that matters. I'm going to hard-kill the server with kill dash nine — no
> graceful shutdown, no cleanup handlers. … It restarts, and reconciliation takes over:
> durable leases expire, the reaper moves abandoned sessions into cleanup, devices are
> cleaned *before* anyone else gets them, and the next fencing token is strictly larger so a
> delayed command from the dead session can't touch the reassigned device."

**[Back in the browser: W4 (the queued one) becomes active automatically.]**

> "And the queued user gets served automatically. Nothing was edited by hand."

## 3:15 – 3:45 · Release + handoff + numbers

**[W2: click "End". Point at W-that-was-queued going active, or the pool counts updating.]**

> "Normal release is the same path — end a session, the device is cleaned and handed to the
> next waiter."

**[Show docs/bench-results or the README performance table.]**

> "Everything's measured, not guessed: about 33 frames a second live, 97-millisecond
> tap-to-pixel latency, 11-millisecond allocation, all from a benchmark you can run. Server
> CPU stays under 3% for three streams."

## 3:45 – 4:00 · Close

**[Show the README top / architecture diagram, or the four-window grid one more time.]**

> "Three shared Android devices, fair leases, crash-safe ownership, and natural-language
> control — deployed on Fly across four apps. It's built so the same scheduler could serve
> a QA agent, or a rack of physical phones, without changing the core. Thanks for watching."

---

## Recording tips

- 1280×800 or 1440×900 capture; hide bookmarks bar and clutter.
- Record system audio off; narrate live or add captions after.
- If the live cloud stream stutters, record against the **local** app (`make dev`) — same UI,
  higher FPS, and the `kill -9` demo is snappier locally.
- Pre-type the long commands into a notes file to paste, so there's no typing dead air.
- For the `kill -9` beat, keep the terminal and W4 both visible so the handoff is on screen.
- Good clip order if editing: hook → 3 leases → queue → NL cursor → kill-9 recovery →
  numbers. Trim waits between steps to keep energy up.
