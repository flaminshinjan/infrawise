import { useEffect, useState } from "react";
import { useLab } from "../hooks/useLab.js";
import { DeviceViewport } from "../components/DeviceViewport.js";
import { ChatPane } from "../components/ChatPane.js";
import type { LabConnection, LabState } from "../lib/connection.js";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="8" fill="#0435DD" />
      <rect
        x="11"
        y="7"
        width="10"
        height="18"
        rx="2.5"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
      />
      <circle cx="16" cy="21.5" r="1.4" fill="#fff" />
    </svg>
  );
}

function ConnectionBadge({ state }: { state: LabState }) {
  if (state.connection === "connected")
    return <span className="badge ok">● connected</span>;
  if (state.connection === "reconnecting")
    return (
      <span className="badge warn">
        reconnecting — holding your spot for 15 s
      </span>
    );
  return <span className="badge">connecting…</span>;
}

function PoolPill({ state }: { state: LabState }) {
  const pool = state.pool;
  if (!pool) return null;
  return (
    <span className="pool-pill">
      <span className="dot free" /> {pool.available} free
      <span className="dot busy" /> {pool.inUse + pool.reserved} in use
      {pool.offline > 0 && (
        <>
          <span className="dot off" /> {pool.offline} offline
        </>
      )}
    </span>
  );
}

function Landing({ lab, state }: { lab: LabConnection; state: LabState }) {
  const now = useNow(1000);

  return (
    <div className="landing">
      <nav className="nav">
        <div className="nav-brand">
          <Mark />
          <span className="brand-name">Shared Device Lab</span>
        </div>
        <div className="nav-right">
          <PoolPill state={state} />
          <ConnectionBadge state={state} />
        </div>
      </nav>

      <main className="hero">
        <span className="eyebrow">An execution substrate for agentic QA</span>
        <h1>
          Real Android devices,
          <br />
          <em>leased fairly</em>, tested live.
        </h1>
        <p className="hero-sub">
          Request a device and get an exclusive, crash-safe lease on a live
          Android emulator — streamed to your browser, driven by touch or by
          plain-language test steps. When you’re done, the next person in line
          takes over automatically.
        </p>

        <div className="hero-action">
          {state.phase === "idle" && (
            <>
              <button className="cta" onClick={() => void lab.requestDevice()}>
                Request a device
              </button>
              <span className="cta-note">
                Fair FIFO queue · 10-minute lease · no sign-up
              </span>
            </>
          )}

          {state.phase === "waiting" && (
            <div className="queue-card">
              <div className="queue-num">{state.position ?? "…"}</div>
              <div className="queue-info">
                <strong>
                  {state.position === 1
                    ? "You’re next"
                    : `${(state.position ?? 1) - 1} ahead of you`}
                </strong>
                <span>
                  waiting{" "}
                  {state.enqueuedAt
                    ? formatDuration(now - state.enqueuedAt)
                    : "…"}{" "}
                  — your spot survives refreshes
                </span>
              </div>
              <button
                className="ghost"
                onClick={() => void lab.cancelRequest()}
              >
                Leave queue
              </button>
            </div>
          )}

          {state.phase === "reserved" && (
            <div className="queue-card">
              <span className="spinner" />
              <div className="queue-info">
                <strong>Device reserved</strong>
                <span>claiming your session…</span>
              </div>
            </div>
          )}

          {state.phase === "ended" && (
            <div className="queue-card ended">
              <div className="queue-info">
                <strong>Session ended</strong>
                <span>reason: {state.endedReason ?? "unknown"}</span>
              </div>
              <button
                className="cta small"
                onClick={() => void lab.requestDevice()}
              >
                Request again
              </button>
            </div>
          )}
        </div>

        {state.lastError && <div className="hero-error">{state.lastError}</div>}
      </main>

      <section className="features">
        <div className="feature">
          <h3>Fair, atomic leases</h3>
          <p>
            One Redis transaction assigns each device — two clients can never
            own the same one. FIFO order with live queue positions, no jumping
            the line.
          </p>
        </div>
        <div className="feature">
          <h3>Crash-safe ownership</h3>
          <p>
            Leases expire, fencing tokens advance, and devices are cleaned
            before reassignment — even after a <code>kill&nbsp;-9</code>.
            Refreshing your tab keeps your session.
          </p>
        </div>
        <div className="feature">
          <h3>Test in plain language</h3>
          <p>
            A chat console compiles sentences like “open notifications, then
            type hello” into ordered, acknowledged device input — the same
            protocol an agent would drive.
          </p>
        </div>
      </section>

      <footer className="footer">
        <span>33 fps live stream</span>
        <span className="sep" />
        <span>97 ms tap-to-pixel (p50)</span>
        <span className="sep" />
        <span>11 ms allocation</span>
        <span className="sep" />
        <span>measured, not estimated — see the repo README</span>
      </footer>
    </div>
  );
}

function Workspace({ lab, state }: { lab: LabConnection; state: LabState }) {
  const now = useNow(1000);
  const session = state.session!;
  return (
    <div className="workspace">
      <header className="ws-bar">
        <div className="nav-brand">
          <Mark />
          <span className="brand-name">Shared Device Lab</span>
        </div>
        <div className="ws-meta">
          <span className="ws-device">{session.device.deviceId}</span>
          <span className="ws-dim">
            {session.device.width}×{session.device.height}
          </span>
          <span className="ws-stat">{state.fps} fps</span>
          {state.inputRttMs !== null && (
            <span className="ws-stat">{state.inputRttMs} ms input</span>
          )}
          <span className="ws-countdown">
            {formatDuration(session.expiresAt - now)} left
          </span>
        </div>
        <div className="ws-right">
          <ConnectionBadge state={state} />
          <button className="ghost danger" onClick={() => lab.endSession()}>
            End session
          </button>
        </div>
      </header>

      <div className="ws-body">
        <ChatPane lab={lab} sessionKey={session.sessionId} />
        <div className="ws-device-col">
          <DeviceViewport
            lab={lab}
            deviceWidth={session.device.width}
            deviceHeight={session.device.height}
          />
          <div className="ws-hint">
            Tap and drag directly on the screen, or drive it from the test
            console.
          </div>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const { lab, state } = useLab();
  if (state.phase === "active" && state.session) {
    return <Workspace lab={lab} state={state} />;
  }
  return <Landing lab={lab} state={state} />;
}
