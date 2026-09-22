import { useEffect, useState, type ReactNode } from "react";
import { useLab } from "../hooks/useLab.js";
import { useTheme, type Theme } from "../hooks/useTheme.js";
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
      <rect x="3" y="2" width="26" height="28" rx="7" className="mark-body" />
      <rect
        x="11"
        y="7"
        width="10"
        height="14"
        rx="2"
        className="mark-screen"
      />
      <circle cx="16" cy="24.5" r="1.6" className="mark-dot" />
    </svg>
  );
}

function ThemeToggle({ theme, toggle }: { theme: Theme; toggle: () => void }) {
  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      title="Toggle theme"
      aria-label="Toggle theme"
    >
      {theme === "light" ? "☾" : "☀"}
    </button>
  );
}

function ConnectionBadge({ state }: { state: LabState }) {
  if (state.connection === "connected")
    return <span className="badge ok">● live</span>;
  if (state.connection === "reconnecting")
    return <span className="badge warn">reconnecting…</span>;
  return <span className="badge">connecting…</span>;
}

function PoolPill({ state }: { state: LabState }) {
  const pool = state.pool;
  if (!pool) return null;
  return (
    <span className="pool-pill">
      <span className="dot free" /> {pool.available}
      <span className="dot busy" /> {pool.inUse + pool.reserved}
      {pool.offline > 0 && (
        <>
          <span className="dot off" /> {pool.offline}
        </>
      )}
    </span>
  );
}

/** Original, generic phone shell — bezel, camera dot, side keys, home bar. */
function Phone({ children }: { children: ReactNode }) {
  return (
    <div className="phone">
      <span className="phone-key phone-power" />
      <span className="phone-key phone-vol-up" />
      <span className="phone-key phone-vol-dn" />
      <div className="phone-screen">
        <div className="phone-status">
          <span className="phone-cam" />
        </div>
        {children}
        <div className="phone-home" />
      </div>
    </div>
  );
}

function Landing({
  lab,
  state,
  theme,
  toggle,
}: {
  lab: LabConnection;
  state: LabState;
  theme: Theme;
  toggle: () => void;
}) {
  const now = useNow(1000);

  return (
    <div className="landing">
      <nav className="nav">
        <div className="nav-brand">
          <Mark />
          <span className="brand-name">Device Lab</span>
        </div>
        <div className="nav-right">
          <PoolPill state={state} />
          <ConnectionBadge state={state} />
          <ThemeToggle theme={theme} toggle={toggle} />
        </div>
      </nav>

      <main className="hero">
        <div className="hero-copy">
          <span className="eyebrow">execution substrate for agentic QA</span>
          <h1>
            Drive real Android
            <br />
            devices <span className="grad">in plain English.</span>
          </h1>
          <p className="hero-sub">
            Lease a live emulator, watch it stream into a phone in your browser,
            and run tests by typing what you want — a cursor flies across the
            screen and does it. Fair queue, crash-safe leases, the next tester
            served automatically.
          </p>

          <div className="hero-action">
            {state.phase === "idle" && (
              <>
                <button
                  className="cta"
                  onClick={() => void lab.requestDevice()}
                >
                  Request a device →
                </button>
                <span className="cta-note">
                  FIFO queue · 10-min lease · no sign-up
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
                    · survives refresh
                  </span>
                </div>
                <button
                  className="ghost"
                  onClick={() => void lab.cancelRequest()}
                >
                  Leave
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
              <div className="queue-card">
                <div className="queue-info">
                  <strong>Session ended</strong>
                  <span>reason: {state.endedReason ?? "unknown"}</span>
                </div>
                <button
                  className="cta small"
                  onClick={() => void lab.requestDevice()}
                >
                  Again →
                </button>
              </div>
            )}
          </div>
          {state.lastError && (
            <div className="hero-error">{state.lastError}</div>
          )}
        </div>

        <div className="hero-visual">
          <Phone>
            <div className="phone-poster">
              <div className="poster-grid">
                {["◎", "✎", "⇧", "⌂", "◐", "✦", "▷", "⚑", "◈"].map((g, i) => (
                  <span key={i} style={{ animationDelay: `${i * 0.12}s` }}>
                    {g}
                  </span>
                ))}
              </div>
              <p className="poster-cap">tap · swipe · type · launch</p>
            </div>
          </Phone>
        </div>
      </main>

      <footer className="footer">
        <span>33 fps live stream</span>
        <span className="sep" />
        <span>97 ms tap-to-pixel</span>
        <span className="sep" />
        <span>11 ms allocation</span>
        <span className="sep" />
        <span>measured, not estimated</span>
      </footer>
    </div>
  );
}

function Workspace({
  lab,
  state,
  theme,
  toggle,
}: {
  lab: LabConnection;
  state: LabState;
  theme: Theme;
  toggle: () => void;
}) {
  const now = useNow(1000);
  const session = state.session!;
  return (
    <div className="workspace">
      <header className="ws-bar">
        <div className="nav-brand">
          <Mark />
          <span className="brand-name">Device Lab</span>
        </div>
        <div className="ws-meta">
          <span className="ws-device">{session.device.deviceId}</span>
          <span className="ws-stat">{state.fps} fps</span>
          {state.inputRttMs !== null && (
            <span className="ws-stat">{state.inputRttMs} ms</span>
          )}
          <span className="ws-countdown">
            {formatDuration(session.expiresAt - now)}
          </span>
        </div>
        <div className="ws-right">
          <ConnectionBadge state={state} />
          <ThemeToggle theme={theme} toggle={toggle} />
          <button className="ghost danger" onClick={() => lab.endSession()}>
            End
          </button>
        </div>
      </header>

      <div className="ws-body">
        <ChatPane lab={lab} sessionKey={session.sessionId} />
        <div className="ws-stage">
          <Phone>
            <DeviceViewport
              lab={lab}
              deviceWidth={session.device.width}
              deviceHeight={session.device.height}
            />
          </Phone>
          <div className="ws-hint">
            Touch the screen directly, or type a command — the cursor will do
            it.
          </div>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const { lab, state } = useLab();
  const { theme, toggle } = useTheme();
  if (state.phase === "active" && state.session) {
    return <Workspace lab={lab} state={state} theme={theme} toggle={toggle} />;
  }
  return <Landing lab={lab} state={state} theme={theme} toggle={toggle} />;
}
