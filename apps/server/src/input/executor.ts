import type { DeviceAdapter, DeviceRef } from "@lab/device-adapter";
import {
  normalizedToDevice,
  type Device,
  type InputAck,
  type InputCommand,
} from "@lab/protocol";
import type { Clock } from "../config.js";
import type { LabStore } from "../scheduler/store.js";
import type { LabMetrics } from "../telemetry/metrics.js";

/**
 * Per-session single-consumer input queue.
 *
 * Ordering: the WebSocket delivers messages in order; commands are appended to
 * a serial promise chain, so ADB execution order equals arrival order.
 * `lastEnqueued` gates admission (strict seq + 1), `lastApplied` gates
 * deduplication, and every command re-validates session state and lease fence
 * against Redis immediately before touching the device, so a stale fence never
 * reaches the adapter.
 */
export class InputExecutor {
  private lastEnqueued: number;
  private lastApplied: number;
  private pending = 0;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly session: { id: string; deviceId: string; fence: number },
    initialSeq: number,
    private readonly deps: {
      store: LabStore;
      adapter: DeviceAdapter;
      deviceRef: DeviceRef;
      clock: Clock;
      metrics: LabMetrics;
      maxPending: number;
      maxTextLength: number;
      onAck: (ack: InputAck) => void;
    },
  ) {
    this.lastEnqueued = initialSeq;
    this.lastApplied = initialSeq;
  }

  get appliedSeq(): number {
    return this.lastApplied;
  }

  /** Reject everything still queued and refuse new commands. */
  stop(): void {
    this.stopped = true;
  }

  submit(cmd: InputCommand): void {
    const { metrics, onAck } = this.deps;
    const kind = cmd.payload.kind;

    if (this.stopped) {
      metrics.inputCommands.inc({ kind, status: "rejected" });
      onAck(reject(cmd, "session is not active"));
      return;
    }
    if (cmd.fence !== this.session.fence) {
      metrics.inputCommands.inc({ kind, status: "rejected" });
      onAck(reject(cmd, "stale fence"));
      return;
    }
    if (cmd.seq <= this.lastEnqueued) {
      // Already applied or currently in flight: never re-execute.
      metrics.inputCommands.inc({ kind, status: "duplicate" });
      onAck({
        type: "input.ack",
        sessionId: cmd.sessionId,
        seq: cmd.seq,
        status: "duplicate",
      });
      return;
    }
    if (cmd.seq !== this.lastEnqueued + 1) {
      metrics.inputCommands.inc({ kind, status: "rejected" });
      onAck(reject(cmd, "sequence gap", this.lastEnqueued + 1));
      return;
    }
    if (this.pending >= this.deps.maxPending) {
      // Not consumed: the client may retry the same seq once drained.
      metrics.inputCommands.inc({ kind, status: "rejected" });
      onAck(reject(cmd, "input queue overloaded, slow down"));
      return;
    }

    this.lastEnqueued = cmd.seq;
    this.pending += 1;
    this.chain = this.chain.then(() => this.execute(cmd));
  }

  private async execute(cmd: InputCommand): Promise<void> {
    const { store, adapter, deviceRef, clock, metrics, onAck } = this.deps;
    const kind = cmd.payload.kind;
    this.pending -= 1;

    if (this.stopped) {
      metrics.inputCommands.inc({ kind, status: "rejected" });
      onAck(reject(cmd, "session ended before execution"));
      return;
    }

    if (
      cmd.payload.kind === "text" &&
      cmd.payload.text.length > this.deps.maxTextLength
    ) {
      // Consumes its sequence slot so client/server stay in sync.
      this.lastApplied = Math.max(this.lastApplied, cmd.seq);
      metrics.inputCommands.inc({ kind, status: "rejected" });
      onAck(reject(cmd, `text too long (max ${this.deps.maxTextLength})`));
      return;
    }

    // Authorization gate immediately before device access: current session
    // must still own the device under the same fence.
    let device: Device | null = null;
    try {
      const [s, d] = await Promise.all([
        store.getSession(cmd.sessionId),
        store.getDevice(this.session.deviceId),
      ]);
      device = d;
      const authorized =
        s !== null &&
        d !== null &&
        s.state === "ACTIVE" &&
        d.currentSessionId === cmd.sessionId &&
        d.leaseFence === cmd.fence &&
        s.leaseFence === cmd.fence &&
        clock.now() < s.expiresAt;
      if (!authorized) {
        metrics.inputCommands.inc({ kind, status: "rejected" });
        onAck(reject(cmd, "session no longer owns the device"));
        return;
      }
    } catch (err) {
      // Redis unavailable: refuse to execute without ownership proof.
      metrics.inputCommands.inc({ kind, status: "rejected" });
      onAck(reject(cmd, "ownership check unavailable"));
      return void err;
    }

    const startedAt = clock.now();
    try {
      const { width, height, rotation } = device!;
      switch (cmd.payload.kind) {
        case "tap": {
          const p = normalizedToDevice(
            cmd.payload.point,
            width,
            height,
            rotation,
          );
          await adapter.tap(deviceRef, p.x, p.y);
          break;
        }
        case "swipe": {
          const from = normalizedToDevice(
            cmd.payload.from,
            width,
            height,
            rotation,
          );
          const to = normalizedToDevice(
            cmd.payload.to,
            width,
            height,
            rotation,
          );
          await adapter.swipe(deviceRef, from, to, cmd.payload.durationMs);
          break;
        }
        case "text":
          await adapter.typeText(deviceRef, cmd.payload.text);
          break;
        case "key":
          await adapter.key(deviceRef, cmd.payload.key);
          break;
        case "launch":
          await adapter.launch(deviceRef, cmd.payload.app);
          break;
      }
      this.lastApplied = Math.max(this.lastApplied, cmd.seq);
      await store
        .updateSessionInputSeq(cmd.sessionId, cmd.seq)
        .catch(() => void 0);
      metrics.inputCommands.inc({ kind, status: "applied" });
      metrics.inputApplySeconds.observe(
        { kind },
        (clock.now() - startedAt) / 1000,
      );
      onAck({
        type: "input.ack",
        sessionId: cmd.sessionId,
        seq: cmd.seq,
        status: "applied",
        appliedAt: clock.now(),
      });
    } catch (err) {
      // The command consumed its sequence slot even though it failed, so the
      // client does not retry it into a reordered position.
      this.lastApplied = Math.max(this.lastApplied, cmd.seq);
      metrics.inputCommands.inc({ kind, status: "rejected" });
      onAck(
        reject(
          cmd,
          `device command failed: ${err instanceof Error ? err.message : "error"}`,
        ),
      );
    }
  }
}

function reject(
  cmd: InputCommand,
  reason: string,
  expectedSeq?: number,
): InputAck {
  return {
    type: "input.ack",
    sessionId: cmd.sessionId,
    seq: cmd.seq,
    status: "rejected",
    reason,
    ...(expectedSeq !== undefined ? { expectedSeq } : {}),
  };
}
