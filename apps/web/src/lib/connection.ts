import {
  decodeFrameHeader,
  FrameCodec,
  type ClientStateSnapshot,
  type DisplayInfo,
  type InputAck,
  type InputPayload,
  type PoolStatus,
  type ServerMessage,
} from "@lab/protocol";

export type InputAckMessage = InputAck;

export type ConnectionStatus = "connecting" | "connected" | "reconnecting";

export interface ActiveSession {
  sessionId: string;
  device: DisplayInfo;
  fence: number;
  expiresAt: number;
}

export interface LabState {
  connection: ConnectionStatus;
  phase: "idle" | "waiting" | "reserved" | "active" | "ended";
  pool: PoolStatus | null;
  requestId: string | null;
  position: number | null;
  enqueuedAt: number | null;
  session: ActiveSession | null;
  endedReason: string | null;
  fps: number;
  frameLatencyMs: number | null;
  inputRttMs: number | null;
  lastError: string | null;
}

export interface FramePayload {
  bitmap: ImageBitmap;
  seq: number;
  capturedAt: number;
}

const HEARTBEAT_INTERVAL_MS = 5000;

/** Same-origin by default (Vite proxy in dev); a separate API deployment sets VITE_API_ORIGIN. */
const API_ORIGIN: string =
  (import.meta.env?.VITE_API_ORIGIN as string | undefined) ?? "";

function wsOrigin(): string {
  if (API_ORIGIN) return API_ORIGIN.replace(/^http/, "ws");
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

function makeToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function getClientToken(): string {
  try {
    const existing = sessionStorage.getItem("lab.clientToken");
    if (existing) return existing;
    const token = makeToken();
    sessionStorage.setItem("lab.clientToken", token);
    return token;
  } catch {
    return makeToken();
  }
}

/**
 * Owns the WebSocket, the client-side session state machine, ordered input
 * sequencing, and frame decoding. React subscribes for re-renders.
 */
export class LabConnection {
  state: LabState = {
    connection: "connecting",
    phase: "idle",
    pool: null,
    requestId: null,
    position: null,
    enqueuedAt: null,
    session: null,
    endedReason: null,
    fps: 0,
    frameLatencyMs: null,
    inputRttMs: null,
    lastError: null,
  };

  onFrame: ((frame: FramePayload) => void) | null = null;

  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private ackListeners = new Set<(ack: InputAckMessage) => void>();
  private readonly clientToken = getClientToken();
  private nextSeq = 1;
  private sentAtBySeq = new Map<number, number>();
  private reconnectDelay = 250;
  private heartbeatTimer: number | null = null;
  private frameTimes: number[] = [];
  private disposed = false;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeAcks(listener: (ack: InputAckMessage) => void): () => void {
    this.ackListeners.add(listener);
    return () => this.ackListeners.delete(listener);
  }

  /** Send one input and resolve with its ack (or a timeout rejection ack). */
  sendInputAwaited(
    payload: InputPayload,
    timeoutMs = 12_000,
  ): Promise<InputAckMessage> {
    const seq = this.sendInput(payload);
    if (seq === null) {
      return Promise.resolve({
        type: "input.ack",
        sessionId: "",
        seq: 0,
        status: "rejected",
        reason: "no active session",
      });
    }
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        unsubscribe();
        resolve({
          type: "input.ack",
          sessionId: "",
          seq,
          status: "rejected",
          reason: "timed out waiting for device",
        });
      }, timeoutMs);
      const unsubscribe = this.subscribeAcks((ack) => {
        if (ack.seq === seq) {
          clearTimeout(timer);
          unsubscribe();
          resolve(ack);
        }
      });
    });
  }

  private update(patch: Partial<LabState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  connect(): void {
    if (this.disposed) return;
    const url = `${wsOrigin()}/api/v1/ws?clientToken=${encodeURIComponent(this.clientToken)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 250;
      this.update({ connection: "connected" });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        this.handleMessage(JSON.parse(ev.data) as ServerMessage);
      } else {
        void this.handleFrame(ev.data as ArrayBuffer);
      }
    };
    ws.onclose = () => {
      if (this.disposed) return;
      this.update({ connection: "reconnecting" });
      this.stopHeartbeat();
      // Exponential backoff capped at 2s: within the server's 15s grace a
      // refresh or blip reconnects to the same session.
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 2000);
    };
    ws.onerror = () => ws.close();
  }

  dispose(): void {
    this.disposed = true;
    this.stopHeartbeat();
    this.ws?.close();
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "hello":
        this.applySnapshot(msg.state);
        this.update({ pool: msg.pool });
        break;
      case "queue.state":
        this.update({
          phase: "waiting",
          requestId: msg.requestId,
          position: msg.position,
          pool: msg.pool,
        });
        break;
      case "session.reserved":
        this.update({ phase: "reserved" });
        this.sendJson({
          type: "session.claim",
          sessionId: msg.sessionId,
          claimToken: msg.claimToken,
        });
        break;
      case "session.active":
        this.nextSeq = msg.lastAcceptedInputSeq + 1;
        this.sentAtBySeq.clear();
        this.update({
          phase: "active",
          session: {
            sessionId: msg.sessionId,
            device: msg.device,
            fence: msg.fence,
            expiresAt: msg.expiresAt,
          },
          requestId: null,
          position: null,
          endedReason: null,
        });
        this.startHeartbeat(msg.sessionId);
        break;
      case "session.ended":
        this.stopHeartbeat();
        this.update({ phase: "ended", session: null, endedReason: msg.reason });
        break;
      case "pool.state":
        this.update({ pool: msg.pool });
        break;
      case "input.ack": {
        const sentAt = this.sentAtBySeq.get(msg.seq);
        if (sentAt !== undefined) {
          this.sentAtBySeq.delete(msg.seq);
          if (msg.status === "applied") {
            this.update({ inputRttMs: Math.round(performance.now() - sentAt) });
          }
        }
        if (msg.status === "rejected" && msg.expectedSeq !== undefined) {
          this.nextSeq = msg.expectedSeq;
        }
        for (const listener of this.ackListeners) listener(msg);
        break;
      }
      case "device.state":
        break;
      case "error":
        this.update({ lastError: msg.message });
        break;
    }
  }

  private applySnapshot(snapshot: ClientStateSnapshot): void {
    switch (snapshot.status) {
      case "IDLE":
        // keep a terminal "ended" screen visible rather than flashing to idle
        if (this.state.phase !== "ended") {
          this.update({
            phase: "idle",
            session: null,
            requestId: null,
            position: null,
          });
        }
        break;
      case "WAITING":
        this.update({
          phase: "waiting",
          requestId: snapshot.requestId,
          position: snapshot.position,
          enqueuedAt: snapshot.enqueuedAt,
        });
        break;
      case "RESERVED":
        this.update({ phase: "reserved" });
        break;
      case "ACTIVE":
        this.nextSeq = snapshot.lastAcceptedInputSeq + 1;
        this.update({
          phase: "active",
          session: {
            sessionId: snapshot.sessionId,
            device: snapshot.device,
            fence: snapshot.fence,
            expiresAt: snapshot.expiresAt,
          },
          endedReason: null,
        });
        this.startHeartbeat(snapshot.sessionId);
        break;
    }
  }

  private async handleFrame(data: ArrayBuffer): Promise<void> {
    const meta = decodeFrameHeader(data);
    if (!meta || !this.onFrame) return;
    const mime = meta.codec === FrameCodec.JPEG ? "image/jpeg" : "image/png";
    try {
      const blob = new Blob([data.slice(24)], { type: mime });
      const bitmap = await createImageBitmap(blob);
      const now = Date.now();
      this.frameTimes.push(now);
      this.frameTimes = this.frameTimes.filter((t) => now - t < 3000);
      this.update({
        fps: Math.round((this.frameTimes.length / 3) * 10) / 10,
        frameLatencyMs: Math.max(0, Math.round(now - meta.capturedAt)),
      });
      this.onFrame({ bitmap, seq: meta.seq, capturedAt: meta.capturedAt });
    } catch {
      // dropped/corrupt frame; next one supersedes it
    }
  }

  // ---------------- actions ----------------

  async requestDevice(): Promise<void> {
    this.update({
      endedReason: null,
      phase: this.state.phase === "ended" ? "idle" : this.state.phase,
    });
    const res = await fetch(`${API_ORIGIN}/api/v1/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientToken: this.clientToken }),
    });
    if (!res.ok) {
      this.update({ lastError: `request failed (${res.status})` });
      return;
    }
    const body = (await res.json()) as {
      status: string;
      requestId?: string;
      position?: number;
    };
    if (body.status === "WAITING" && body.requestId) {
      this.update({
        phase: "waiting",
        requestId: body.requestId,
        position: body.position ?? null,
        enqueuedAt: Date.now(),
      });
    }
  }

  async cancelRequest(): Promise<void> {
    if (!this.state.requestId) return;
    await fetch(`${API_ORIGIN}/api/v1/requests/${this.state.requestId}`, {
      method: "DELETE",
      headers: { "x-client-token": this.clientToken },
    });
    this.update({ phase: "idle", requestId: null, position: null });
  }

  endSession(): void {
    if (!this.state.session) return;
    this.sendJson({
      type: "session.end",
      sessionId: this.state.session.sessionId,
    });
  }

  sendInput(payload: InputPayload): number | null {
    const session = this.state.session;
    if (!session || this.state.phase !== "active") return null;
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.sentAtBySeq.set(seq, performance.now());
    this.sendJson({
      type: "input.command",
      sessionId: session.sessionId,
      fence: session.fence,
      seq,
      sentAt: Date.now(),
      payload,
    });
    return seq;
  }

  private startHeartbeat(sessionId: string): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.sendJson({ type: "session.heartbeat", sessionId });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendJson(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
