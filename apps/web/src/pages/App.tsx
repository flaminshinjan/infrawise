import { useEffect, useState } from "react";
import { useLab } from "../hooks/useLab.js";
import { DeviceViewport } from "../components/DeviceViewport.js";

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

export function App() {
  const { lab, state } = useLab();
  const now = useNow(1000);
  const [text, setText] = useState("");

  const pool = state.pool;
  const poolLine = pool
    ? `${pool.available} available · ${pool.inUse + pool.reserved} active · ${pool.cleaning} cleaning · ${pool.offline} offline`
    : "…";

  const connBadge =
    state.connection === "connected" ? (
      <span className="badge ok">connected</span>
    ) : state.connection === "reconnecting" ? (
      <span className="badge warn">
        reconnecting — holding your session for 15s
      </span>
    ) : (
      <span className="badge">connecting…</span>
    );

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Shared Device Lab</h1>
          <p className="subtitle">
            Three Android devices. Fair leases. Live control.
          </p>
        </div>
        <div className="topbar-right">
          {connBadge}
          <span className="pool">{poolLine}</span>
        </div>
      </header>

      {state.lastError && <div className="error-bar">{state.lastError}</div>}

      {state.phase === "idle" && (
        <main className="center-card">
          <button className="primary" onClick={() => void lab.requestDevice()}>
            Request a device
          </button>
          <p className="hint">
            You’ll get an exclusive lease on one of the lab’s Android emulators.
          </p>
        </main>
      )}

      {state.phase === "waiting" && (
        <main className="center-card">
          <div className="queue-position">{state.position ?? "…"}</div>
          <p className="queue-copy">
            {state.position === 1
              ? "You’re next"
              : `${(state.position ?? 1) - 1} ahead of you`}
          </p>
          {state.enqueuedAt && (
            <p className="hint">
              waiting {formatDuration(now - state.enqueuedAt)}
            </p>
          )}
          <button
            className="secondary"
            onClick={() => void lab.cancelRequest()}
          >
            Cancel
          </button>
        </main>
      )}

      {state.phase === "reserved" && (
        <main className="center-card">
          <div className="spinner" />
          <p className="queue-copy">Device reserved — claiming…</p>
        </main>
      )}

      {state.phase === "active" && state.session && (
        <main className="active-layout">
          <div className="session-bar">
            <span className="device-id">
              {state.session.device.deviceId} · {state.session.device.width}×
              {state.session.device.height}
            </span>
            <span className="countdown">
              ends in {formatDuration(state.session.expiresAt - now)}
            </span>
            <span className="stats">
              {state.fps} fps
              {state.frameLatencyMs !== null &&
                ` · frame ${state.frameLatencyMs}ms`}
              {state.inputRttMs !== null && ` · input ${state.inputRttMs}ms`}
            </span>
          </div>
          <DeviceViewport
            lab={lab}
            deviceWidth={state.session.device.width}
            deviceHeight={state.session.device.height}
          />
          <div className="controls">
            <button onClick={() => lab.sendInput({ kind: "key", key: "BACK" })}>
              ◀ Back
            </button>
            <button onClick={() => lab.sendInput({ kind: "key", key: "HOME" })}>
              ● Home
            </button>
            <form
              className="text-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim().length > 0) {
                  lab.sendInput({ kind: "text", text });
                  setText("");
                }
              }}
            >
              <input
                type="text"
                placeholder="Type text, press Enter to send"
                value={text}
                maxLength={512}
                onChange={(e) => setText(e.target.value)}
              />
              <button type="submit">Send</button>
            </form>
            <button className="danger" onClick={() => lab.endSession()}>
              End session
            </button>
          </div>
        </main>
      )}

      {state.phase === "ended" && (
        <main className="center-card">
          <p className="queue-copy">Session ended</p>
          <p className="hint">reason: {state.endedReason ?? "unknown"}</p>
          <button className="primary" onClick={() => void lab.requestDevice()}>
            Request a device
          </button>
        </main>
      )}
    </div>
  );
}
