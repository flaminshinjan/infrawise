import { useEffect, useState, type ReactNode } from "react";
import { useLab } from "../hooks/useLab.js";
import { useTheme, type Theme } from "../hooks/useTheme.js";
import { DeviceViewport } from "../components/DeviceViewport.js";
import { ChatPane } from "../components/ChatPane.js";
import { resolveProfile, type DeviceProfile } from "../lib/deviceProfiles.js";
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

/** Original phone shell — bezel, camera cutout, side keys, home bar. The
 *  screen aspect ratio, corner radius, and camera placement follow the device
 *  profile so different Pixel models read as different phones. */
function Phone({
  profile,
  children,
}: {
  profile: DeviceProfile;
  children: ReactNode;
}) {
  return (
    <div className="phone">
      <span className="phone-key phone-power" />
      <span className="phone-key phone-vol-up" />
      <span className="phone-key phone-vol-dn" />
      <div
        className="phone-screen"
        style={{ aspectRatio: profile.aspect, borderRadius: profile.radius }}
      >
        {profile.camera !== "none" && (
          <div className={`phone-status cam-${profile.camera}`}>
            <span className="phone-cam" />
          </div>
        )}
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

      <main className="hero-text">
        <span className="eyebrow">execution substrate for agentic QA</span>
        <h1>
          Real Android devices,
          <br />
          <span className="grad">leased fairly, tested in plain English.</span>
        </h1>
        <p className="hero-sub">
          Request a live emulator and get an exclusive, crash-safe lease streamed
          to your browser. Drive it by touch, or type what you want — an on-screen
          cursor flies across the device and does it. A fair FIFO queue hands the
          device to the next tester the moment you’re done.
        </p>

        <div className="hero-action center">
          {state.phase === "idle" && (
            <>
              <button className="cta" onClick={() => void lab.requestDevice()}>
                Request a device →
              </button>
              <span className="cta-note">
                FIFO queue · 10-minute lease · no sign-up
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
                  {state.enqueuedAt ? formatDuration(now - state.enqueuedAt) : "…"}{" "}
                  · survives refresh
                </span>
              </div>
              <button className="ghost" onClick={() => void lab.cancelRequest()}>
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
              <button className="cta small" onClick={() => void lab.requestDevice()}>
                Again →
              </button>
            </div>
          )}
        </div>
        {state.lastError && <div className="hero-error">{state.lastError}</div>}

        <div className="cmd-strip">
          {["open settings", "swipe up, then tap the center", 'type "hello"', "open the camera"].map(
            (c) => (
              <code key={c}>{c}</code>
            ),
          )}
        </div>
      </main>

      <section className="steps">
        <div className="step">
          <span className="step-n">01</span>
          <h3>Request &amp; lease</h3>
          <p>
            One atomic Redis transaction assigns a device — two clients can never
            own the same one. If all three are busy you join a live FIFO queue.
          </p>
        </div>
        <div className="step">
          <span className="step-n">02</span>
          <h3>Drive it live</h3>
          <p>
            The device streams to your browser. Tap and swipe directly, or type
            commands in plain language — taps, swipes, typing, app launches — and
            watch the cursor execute each one in order.
          </p>
        </div>
        <div className="step">
          <span className="step-n">03</span>
          <h3>Release &amp; recover</h3>
          <p>
            End the session, refresh, or crash the server — leases expire, devices
            are cleaned before reassignment, and the next tester is served
            automatically.
          </p>
        </div>
      </section>

      <section className="creds">
        <div className="cred">
          <strong>Atomic, fair allocation</strong>
          <p>Lua-scripted leases + fencing tokens. Proven by a race test: 8 allocators, 1 device, exactly one owner.</p>
        </div>
        <div className="cred">
          <strong>Crash-safe by design</strong>
          <p>TTL leases, a reaper, and startup reconciliation survive <code>kill&nbsp;-9</code> with no shutdown hooks.</p>
        </div>
        <div className="cred">
          <strong>Natural-language testing</strong>
          <p>A deterministic parser plus an LLM fallback compile English into the same ordered, fenced input protocol.</p>
        </div>
        <div className="cred">
          <strong>Three real Pixels</strong>
          <p>Pixel 8, 4a and 3 — distinct resolutions and frames — streamed with latest-frame-wins backpressure.</p>
        </div>
      </section>

      <footer className="footer">
        <span>33 fps live stream</span>
        <span className="sep" />
        <span>97 ms tap-to-pixel</span>
        <span className="sep" />
        <span>11 ms allocation</span>
        <span className="sep" />
        <span>45 automated tests</span>
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
  const profile = resolveProfile(session.device.width, session.device.height);
  return (
    <div className="workspace">
      <header className="ws-bar">
        <div className="nav-brand">
          <Mark />
          <span className="brand-name">Device Lab</span>
        </div>
        <div className="ws-meta">
          <span className="ws-device">{profile.name}</span>
          <span className="ws-stat">{profile.resolution}</span>
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
          <Phone profile={profile}>
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
