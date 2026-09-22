import type { WebSocket } from "ws";
import { ClientMessageSchema, type ServerMessage } from "@lab/protocol";
import type { ClientTransport, Logger } from "../core.js";
import type { LabCore } from "../core.js";
import type { LabMetrics } from "../telemetry/metrics.js";

interface SocketState {
  ws: WebSocket;
  clientToken: string;
  clientId: string;
  /** latest-frame-wins: at most one unsent frame; newer frames replace it */
  pendingFrame: Uint8Array | null;
  flushTimer: NodeJS.Timeout | null;
  msgTimestamps: number[];
}

const MAX_WS_MESSAGE_BYTES = 32 * 1024;
const MAX_MSGS_PER_SECOND = 60;
const FLUSH_INTERVAL_MS = 40;

/**
 * WebSocket fan-out. Control/state messages are always sent immediately (they
 * are tiny and must never queue behind video); binary frames use
 * latest-frame-wins per socket: when the socket's kernel buffer is above the
 * threshold the newest frame replaces the pending one and the stale frame is
 * counted as dropped.
 */
export class WsHub implements ClientTransport {
  private sockets = new Map<string, Set<SocketState>>();

  constructor(
    private readonly core: LabCore,
    private readonly metrics: LabMetrics,
    private readonly log: Logger,
    private readonly maxBufferedBytes: number,
  ) {}

  connectedClientCount(): number {
    return this.sockets.size;
  }

  async register(
    ws: WebSocket,
    clientToken: string,
    clientId: string,
  ): Promise<void> {
    const state: SocketState = {
      ws,
      clientToken,
      clientId,
      pendingFrame: null,
      flushTimer: null,
      msgTimestamps: [],
    };
    let set = this.sockets.get(clientId);
    if (!set) {
      set = new Set();
      this.sockets.set(clientId, set);
    }
    set.add(state);

    ws.on(
      "message",
      (raw, isBinary) => void this.onMessage(state, raw as Buffer, isBinary),
    );
    ws.on("close", () => void this.onClose(state));
    ws.on("error", () => void 0);

    const snapshot = await this.core.clientConnected(clientToken);
    const pool = await this.core.poolStatus();
    this.sendTo(state, { type: "hello", state: snapshot, pool });
  }

  private async onMessage(
    state: SocketState,
    raw: Buffer,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary || raw.byteLength > MAX_WS_MESSAGE_BYTES) {
      this.sendTo(state, {
        type: "error",
        code: "BAD_MESSAGE",
        message: "invalid message",
      });
      return;
    }
    // Flood guard: sliding one-second window per socket.
    const now = Date.now();
    state.msgTimestamps = state.msgTimestamps.filter((t) => now - t < 1000);
    state.msgTimestamps.push(now);
    if (state.msgTimestamps.length > MAX_MSGS_PER_SECOND) {
      this.sendTo(state, {
        type: "error",
        code: "RATE_LIMITED",
        message: "too many messages",
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      this.sendTo(state, {
        type: "error",
        code: "BAD_JSON",
        message: "invalid JSON",
      });
      return;
    }
    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.sendTo(state, {
        type: "error",
        code: "BAD_SCHEMA",
        message: "schema validation failed",
      });
      return;
    }
    const msg = result.data;
    try {
      switch (msg.type) {
        case "session.claim": {
          const res = await this.core.claimSession(
            state.clientToken,
            msg.sessionId,
            msg.claimToken,
          );
          if (!res.ok) {
            this.sendTo(state, {
              type: "error",
              code: "CLAIM_FAILED",
              message: res.error ?? "claim failed",
            });
          }
          break;
        }
        case "session.heartbeat":
          await this.core.heartbeat(state.clientToken, msg.sessionId);
          break;
        case "input.command":
          this.core.handleInput(state.clientToken, msg);
          break;
        case "session.end":
          await this.core.endSession(state.clientToken, msg.sessionId);
          break;
        case "stream.feedback":
          // reserved for adaptive quality; currently informational
          break;
      }
    } catch (err) {
      this.log.error({ event: "ws_dispatch_error", err: String(err) });
      this.sendTo(state, {
        type: "error",
        code: "INTERNAL",
        message: "internal error",
      });
    }
  }

  private async onClose(state: SocketState): Promise<void> {
    if (state.flushTimer) clearInterval(state.flushTimer);
    const set = this.sockets.get(state.clientId);
    if (set) {
      set.delete(state);
      if (set.size === 0) {
        this.sockets.delete(state.clientId);
        await this.core
          .clientDisconnected(state.clientToken)
          .catch(() => void 0);
      }
    }
  }

  // ---------------- ClientTransport ----------------

  send(clientId: string, message: ServerMessage): void {
    const set = this.sockets.get(clientId);
    if (!set) return;
    for (const state of set) this.sendTo(state, message);
  }

  sendFrame(clientId: string, data: Uint8Array): void {
    const set = this.sockets.get(clientId);
    if (!set) return;
    for (const state of set) {
      if (state.ws.readyState !== state.ws.OPEN) continue;
      if (
        state.ws.bufferedAmount < this.maxBufferedBytes &&
        state.pendingFrame === null
      ) {
        state.ws.send(data, { binary: true });
        this.metrics.framesSent.inc();
      } else {
        if (state.pendingFrame !== null) this.metrics.framesDropped.inc();
        state.pendingFrame = data;
        if (!state.flushTimer) {
          state.flushTimer = setInterval(
            () => this.flush(state),
            FLUSH_INTERVAL_MS,
          );
        }
      }
    }
  }

  private flush(state: SocketState): void {
    if (state.ws.readyState !== state.ws.OPEN) {
      if (state.flushTimer) clearInterval(state.flushTimer);
      state.flushTimer = null;
      state.pendingFrame = null;
      return;
    }
    if (
      state.pendingFrame !== null &&
      state.ws.bufferedAmount < this.maxBufferedBytes
    ) {
      state.ws.send(state.pendingFrame, { binary: true });
      this.metrics.framesSent.inc();
      state.pendingFrame = null;
    }
    if (state.pendingFrame === null && state.flushTimer) {
      clearInterval(state.flushTimer);
      state.flushTimer = null;
    }
  }

  private sendTo(state: SocketState, message: ServerMessage): void {
    if (state.ws.readyState === state.ws.OPEN) {
      state.ws.send(JSON.stringify(message));
    }
  }
}
