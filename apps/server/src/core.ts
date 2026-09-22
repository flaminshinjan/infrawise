import { createHash, randomBytes } from "node:crypto";
import type { DeviceAdapter, StreamHandle } from "@lab/device-adapter";
import {
  encodeFrame,
  FrameCodec,
  NONTERMINAL_SESSION_STATES,
  type ClientStateSnapshot,
  type Device,
  type DisplayInfo,
  type InputCommand,
  type PoolStatus,
  type ServerMessage,
  type Session,
} from "@lab/protocol";
import { systemClock, type Clock, type LabConfig } from "./config.js";
import { InputExecutor } from "./input/executor.js";
import { LabStore } from "./scheduler/store.js";
import { LabMetrics } from "./telemetry/metrics.js";

export interface ClientTransport {
  send(clientId: string, message: ServerMessage): void;
  sendFrame(clientId: string, data: Uint8Array): void;
}

export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

interface SessionRuntime {
  sessionId: string;
  clientId: string;
  deviceId: string;
  adbSerial: string;
  fence: number;
  executor: InputExecutor;
  stream?: StreamHandle;
  frameSeq: number;
  streamRestarts: number;
}

export function clientIdFromToken(clientToken: string): {
  clientId: string;
  tokenHash: string;
} {
  const tokenHash = createHash("sha256").update(clientToken).digest("hex");
  return { clientId: tokenHash.slice(0, 16), tokenHash };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const id = (p: string) => `${p}_${randomBytes(9).toString("base64url")}`;

/**
 * LabCore owns every state transition. The HTTP/WS layer is a thin shell that
 * authenticates a clientToken and forwards calls; tests drive this class
 * directly with a fake adapter, real Redis, and a manual clock.
 */
export class LabCore {
  readonly runtimes = new Map<string, SessionRuntime>();
  private timers: NodeJS.Timeout[] = [];
  private pumping = false;
  private pumpAgain = false;
  private stopped = false;

  constructor(
    readonly store: LabStore,
    readonly adapter: DeviceAdapter,
    readonly config: LabConfig,
    readonly metrics: LabMetrics,
    private transport: ClientTransport,
    readonly log: Logger,
    readonly clock: Clock = systemClock,
    /** injectable so tests do not sleep for real */
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  setTransport(transport: ClientTransport): void {
    this.transport = transport;
  }

  // ---------------- bootstrap & lifecycle ----------------

  async bootstrap(): Promise<void> {
    await this.attachRemoteDevices();
    await this.registerConfiguredDevices();
    await this.reconcileAfterRestart();
    await this.refreshGauges();
    void this.pump();
  }

  start(): void {
    this.timers.push(
      setInterval(
        () => void this.reaperRunOnce().catch(this.logErr("reaper")),
        this.config.reaperIntervalMs,
      ),
      setInterval(
        () => void this.healthRunOnce().catch(this.logErr("health")),
        this.config.deviceHealthIntervalMs,
      ),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const runtime of [...this.runtimes.values()]) {
      await this.stopRuntime(runtime.sessionId);
    }
  }

  private logErr(what: string) {
    return (err: unknown) =>
      this.log.error({
        event: `${what}_error`,
        err: err instanceof Error ? err.message : String(err),
      });
  }

  private async registerConfiguredDevices(): Promise<void> {
    // Prune registry entries dropped from config (e.g. a device moved labs),
    // but never while they still own a session.
    for (const deviceId of await this.store.listDeviceIds()) {
      if (this.config.deviceSerials.includes(deviceId)) continue;
      const device = await this.store.getDevice(deviceId);
      if (device?.currentSessionId) continue;
      await this.store.unregisterDevice(deviceId);
      this.log.info({ event: "device_unregistered", deviceId });
    }
    const discovered = await this.adapter.discover().catch(() => []);
    const discoveredSerials = new Set(discovered.map((d) => d.adbSerial));
    for (const serial of this.config.deviceSerials) {
      const existing = await this.store.getDevice(serial);
      if (existing) continue; // reconcile handles state repair
      const online = discoveredSerials.has(serial);
      let width = 720;
      let height = 1280;
      if (online) {
        try {
          const info = await this.adapter.displayInfo({
            id: serial,
            adbSerial: serial,
          });
          width = info.width;
          height = info.height;
        } catch {
          // registered but unreadable -> starts OFFLINE below
        }
      }
      const device: Device = {
        id: serial,
        adbSerial: serial,
        kind: serial.startsWith("emulator-")
          ? "ANDROID_EMULATOR"
          : "ANDROID_PHYSICAL",
        state: online ? "AVAILABLE" : "OFFLINE",
        width,
        height,
        rotation: 0,
        lastHealthAt: this.clock.now(),
        failureCount: 0,
      };
      await this.store.registerDevice(device, online);
      this.log.info({
        event: "device_registered",
        deviceId: serial,
        state: device.state,
      });
    }
  }

  /**
   * Crash recovery on startup. kill -9 leaves sessions RESERVED/ACTIVE/
   * DISCONNECTED/ENDING/CLEANING in Redis with no runtime in this process.
   */
  private async reconcileAfterRestart(): Promise<void> {
    const now = this.clock.now();
    await this.store.emitEvent("SERVER_RESTARTED", { at: now });

    // Kill orphaned capture subprocesses recorded by the previous process.
    for (const deviceId of await this.store.listDeviceIds()) {
      const pids = await this.store.getStreamPids(deviceId);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
          this.metrics.recoveries.inc({ reason: "orphan_process" });
          this.log.info({ event: "orphan_process_killed", deviceId, pid });
        } catch {
          // already gone
        }
      }
      await this.store.setStreamPids(deviceId, []);
    }

    for (const sessionId of await this.store.listNonterminalSessionIds()) {
      const session = await this.store.getSession(sessionId);
      if (!session) continue;
      const leaseAlive = await this.store.hasLease(sessionId);
      switch (session.state) {
        case "ACTIVE": {
          // The client may still be there; give it the normal reconnect grace.
          const deadline = now + this.config.reconnectGraceMs;
          await this.store.markDisconnected(sessionId, now, deadline);
          this.metrics.recoveries.inc({
            reason: leaseAlive ? "restart_fast" : "stale_lease",
          });
          this.log.info({
            event: "session_recovered_to_grace",
            sessionId,
            deviceId: session.deviceId,
          });
          break;
        }
        case "DISCONNECTED":
        case "RESERVED":
          // Deadlines are durable; the reaper enforces them.
          break;
        case "ENDING":
        case "EXPIRED":
        case "CLEANING": {
          // Crash mid-termination: cleanup is idempotent, run it again.
          this.metrics.recoveries.inc({ reason: "resume_cleanup" });
          void this.cleanupDevice(session);
          break;
        }
        default:
          break;
      }
    }

    // Repair the available set: devices whose bound session no longer exists.
    for (const deviceId of await this.store.listDeviceIds()) {
      const device = await this.store.getDevice(deviceId);
      if (!device) continue;
      if (device.currentSessionId) {
        const session = await this.store.getSession(device.currentSessionId);
        if (!session || !NONTERMINAL_SESSION_STATES.includes(session.state)) {
          this.log.warn({ event: "device_orphaned_binding_cleaned", deviceId });
          this.metrics.recoveries.inc({ reason: "orphan_binding" });
          void this.cleanupDevice({
            id: device.currentSessionId,
            deviceId,
          } as Session);
        }
      }
      await this.store.setDeviceAvailability(
        deviceId,
        device.state === "AVAILABLE",
      );
    }
  }

  // ---------------- client-facing operations ----------------

  async createRequest(clientToken: string): Promise<ClientStateSnapshot> {
    const { clientId, tokenHash } = clientIdFromToken(clientToken);
    const result = await this.store.joinQueue(
      clientId,
      tokenHash,
      id("req"),
      this.clock.now(),
    );
    if (result.kind === "JOINED") {
      this.log.info({
        event: "queue_joined",
        clientId,
        requestId: result.entry.requestId,
      });
      void this.pump();
      void this.broadcastQueueAndPool();
    }
    return this.getStateByClientId(clientId);
  }

  async getState(clientToken: string): Promise<ClientStateSnapshot> {
    const { clientId } = clientIdFromToken(clientToken);
    return this.getStateByClientId(clientId);
  }

  async getStateByClientId(clientId: string): Promise<ClientStateSnapshot> {
    const sessionId = await this.store.getClientSessionId(clientId);
    if (sessionId) {
      const session = await this.store.getSession(sessionId);
      if (session && NONTERMINAL_SESSION_STATES.includes(session.state)) {
        if (session.state === "RESERVED") {
          return {
            status: "RESERVED",
            sessionId,
            claimBy: session.claimDeadline ?? 0,
          };
        }
        const device = await this.store.getDevice(session.deviceId);
        return {
          status: "ACTIVE",
          sessionId,
          device: displayInfo(device),
          fence: session.leaseFence,
          expiresAt: session.expiresAt,
          lastAcceptedInputSeq: session.lastAcceptedInputSeq,
        };
      }
    }
    const requestId = await this.store.getClientRequestId(clientId);
    if (requestId) {
      const entry = await this.store.getQueueEntry(requestId);
      if (entry?.state === "WAITING") {
        const position = await this.positionOf(requestId);
        return {
          status: "WAITING",
          requestId,
          position,
          enqueuedAt: entry.enqueuedAt,
        };
      }
    }
    return { status: "IDLE" };
  }

  async claimSession(
    clientToken: string,
    sessionId: string,
    claimToken: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const { clientId } = clientIdFromToken(clientToken);
    return this.claimInternal(clientId, sessionId, hashToken(claimToken));
  }

  private async claimInternal(
    clientId: string,
    sessionId: string,
    claimTokenHash: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await this.store.claim(
      sessionId,
      clientId,
      claimTokenHash,
      this.clock.now(),
      this.config.sessionMaxMs,
    );
    if (!res.ok) return { ok: false, error: res.code };
    await this.activateRuntime(res.value.session, res.value.device);
    this.metrics.sessionsStarted.inc();
    void this.broadcastQueueAndPool();
    return { ok: true };
  }

  async cancelRequest(
    clientToken: string,
    requestId: string,
  ): Promise<boolean> {
    const { clientId } = clientIdFromToken(clientToken);
    const res = await this.store.cancelRequest(
      requestId,
      clientId,
      "cancelled",
    );
    if (res === "OK") {
      this.log.info({ event: "queue_cancelled", clientId, requestId });
      void this.broadcastQueueAndPool();
      return true;
    }
    return false;
  }

  async endSession(clientToken: string, sessionId: string): Promise<boolean> {
    const { clientId } = clientIdFromToken(clientToken);
    const session = await this.store.getSession(sessionId);
    if (!session || session.clientId !== clientId) return false;
    return this.terminateSession(sessionId, "user", "ENDING");
  }

  async heartbeat(clientToken: string, sessionId: string): Promise<void> {
    const { clientId } = clientIdFromToken(clientToken);
    await this.store.heartbeat(
      sessionId,
      clientId,
      this.clock.now(),
      this.config.leaseTtlMs,
    );
  }

  handleInput(clientToken: string, cmd: InputCommand): void {
    const { clientId } = clientIdFromToken(clientToken);
    const runtime = this.runtimes.get(cmd.sessionId);
    if (!runtime || runtime.clientId !== clientId) {
      this.metrics.inputCommands.inc({
        kind: cmd.payload.kind,
        status: "rejected",
      });
      this.transport.send(clientId, {
        type: "input.ack",
        sessionId: cmd.sessionId,
        seq: cmd.seq,
        status: "rejected",
        reason: "no active session",
      });
      return;
    }
    runtime.executor.submit(cmd);
  }

  /**
   * WS connect (initial or refresh): restore the client's state, resuming a
   * DISCONNECTED session or auto-claiming a still-valid reservation.
   */
  async clientConnected(clientToken: string): Promise<ClientStateSnapshot> {
    const { clientId } = clientIdFromToken(clientToken);
    const sessionId = await this.store.getClientSessionId(clientId);
    if (sessionId) {
      const session = await this.store.getSession(sessionId);
      if (session?.state === "DISCONNECTED") {
        const res = await this.store.reconnect(
          sessionId,
          clientId,
          this.clock.now(),
        );
        if (res.ok) {
          this.log.info({ event: "session_reconnected", clientId, sessionId });
          await this.activateRuntime(res.value.session, res.value.device);
        }
      } else if (session?.state === "RESERVED") {
        // Connection itself proves liveness; claim on the client's behalf.
        await this.claimInternal(clientId, sessionId, "");
      }
    }
    return this.getStateByClientId(clientId);
  }

  async clientDisconnected(clientToken: string): Promise<void> {
    const { clientId } = clientIdFromToken(clientToken);
    const sessionId = await this.store.getClientSessionId(clientId);
    if (!sessionId) return;
    const now = this.clock.now();
    const res = await this.store.markDisconnected(
      sessionId,
      now,
      now + this.config.reconnectGraceMs,
    );
    if (res === "OK") {
      this.log.info({ event: "client_disconnected", clientId, sessionId });
      // Stream keeps running during grace; frames simply have no socket.
    }
  }

  // ---------------- allocation ----------------

  /** Work-conserving allocation loop; safe to call from anywhere, coalesces. */
  async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      for (;;) {
        const claimToken = randomBytes(24).toString("base64url");
        const endTimer = this.metrics.allocationSeconds.startTimer();
        const result = await this.store.allocate({
          now: this.clock.now(),
          sessionId: id("ses"),
          claimTokenHash: hashToken(claimToken),
          claimMs: this.config.reservationClaimMs,
          sessionMaxMs: this.config.sessionMaxMs,
          leaseTtlMs: this.config.leaseTtlMs,
        });
        endTimer();
        if (!result) break;
        const { session, enqueuedAt } = result;
        this.metrics.queueWaitSeconds.observe(
          (this.clock.now() - enqueuedAt) / 1000,
        );
        this.log.info({
          event: "device_reserved",
          deviceId: session.deviceId,
          sessionId: session.id,
          clientId: session.clientId,
          fence: session.leaseFence,
        });
        this.transport.send(session.clientId, {
          type: "session.reserved",
          sessionId: session.id,
          claimToken,
          claimBy: session.claimDeadline ?? 0,
        });
        void this.broadcastQueueAndPool();
      }
    } finally {
      this.pumping = false;
      if (this.pumpAgain) {
        this.pumpAgain = false;
        void this.pump();
      }
    }
  }

  // ---------------- session runtime ----------------

  private async activateRuntime(
    session: Session,
    device: Device,
  ): Promise<void> {
    const existing = this.runtimes.get(session.id);
    if (existing) {
      this.sendSessionActive(session, device, existing.executor.appliedSeq);
      return;
    }
    const runtime: SessionRuntime = {
      sessionId: session.id,
      clientId: session.clientId,
      deviceId: device.id,
      adbSerial: device.adbSerial,
      fence: session.leaseFence,
      executor: new InputExecutor(
        { id: session.id, deviceId: device.id, fence: session.leaseFence },
        session.lastAcceptedInputSeq,
        {
          store: this.store,
          adapter: this.adapter,
          deviceRef: { id: device.id, adbSerial: device.adbSerial },
          clock: this.clock,
          metrics: this.metrics,
          maxPending: this.config.inputMaxPending,
          maxTextLength: this.config.inputMaxTextLength,
          onAck: (ack) => this.transport.send(session.clientId, ack),
        },
      ),
      frameSeq: 0,
      streamRestarts: 0,
    };
    this.runtimes.set(session.id, runtime);
    await this.startStream(runtime, device);
    this.sendSessionActive(session, device, session.lastAcceptedInputSeq);
  }

  private sendSessionActive(
    session: Session,
    device: Device,
    lastSeq: number,
  ): void {
    this.transport.send(session.clientId, {
      type: "session.active",
      sessionId: session.id,
      device: displayInfo(device),
      fence: session.leaseFence,
      expiresAt: session.expiresAt,
      lastAcceptedInputSeq: lastSeq,
    });
  }

  private async startStream(
    runtime: SessionRuntime,
    device: Device,
  ): Promise<void> {
    try {
      const handle = await this.adapter.startStream(
        { id: device.id, adbSerial: device.adbSerial },
        (frame) => {
          runtime.frameSeq += 1;
          this.metrics.framesProduced.inc({ deviceId: device.id });
          const encoded = encodeFrame(
            {
              codec: frame.codec === "jpeg" ? FrameCodec.JPEG : FrameCodec.PNG,
              width: frame.width,
              height: frame.height,
              seq: runtime.frameSeq,
              fence: runtime.fence,
              capturedAt: frame.capturedAt,
            },
            frame.data,
          );
          this.transport.sendFrame(runtime.clientId, encoded);
        },
        {
          mode: this.config.streamMode,
          fps: this.config.streamFps,
          jpegQuality: this.config.streamJpegQuality,
          onExit: (reason) => void this.onStreamExit(runtime, reason),
        },
      );
      runtime.stream = handle;
      await this.store.setStreamPids(device.id, handle.pids);
      this.log.info({
        event: "stream_started",
        deviceId: device.id,
        sessionId: runtime.sessionId,
        mode: handle.mode,
      });
    } catch (err) {
      this.log.error({
        event: "stream_start_failed",
        deviceId: device.id,
        err: String(err),
      });
      void this.terminateSession(runtime.sessionId, "device_error", "ENDING");
    }
  }

  private async onStreamExit(
    runtime: SessionRuntime,
    reason: string,
  ): Promise<void> {
    if (!this.runtimes.has(runtime.sessionId) || this.stopped) return;
    this.log.warn({
      event: "stream_exited",
      sessionId: runtime.sessionId,
      reason,
    });
    if (runtime.streamRestarts >= 1) {
      void this.terminateSession(runtime.sessionId, "stream_error", "ENDING");
      return;
    }
    runtime.streamRestarts += 1;
    const device = await this.store.getDevice(runtime.deviceId);
    if (device) await this.startStream(runtime, device);
  }

  private async stopRuntime(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    runtime.executor.stop();
    await runtime.stream?.stop().catch(() => void 0);
    await this.store.setStreamPids(runtime.deviceId, []).catch(() => void 0);
  }

  // ---------------- termination & cleanup ----------------

  async terminateSession(
    sessionId: string,
    reason: string,
    terminalState: "ENDING" | "EXPIRED",
    expectedFence?: number,
  ): Promise<boolean> {
    const res = await this.store.beginTermination(
      sessionId,
      reason,
      terminalState,
      this.clock.now(),
      expectedFence,
    );
    if (!res.ok) return false;
    const session = res.value;
    this.log.info({
      event: "session_terminating",
      sessionId,
      deviceId: session.deviceId,
      reason,
    });
    this.metrics.sessionsEnded.inc({ reason });
    await this.stopRuntime(sessionId);
    this.transport.send(session.clientId, {
      type: "session.ended",
      sessionId,
      reason,
    });
    void this.cleanupDevice(session);
    return true;
  }

  /** Idempotent: safe to run from the normal path and from crash recovery. */
  async cleanupDevice(
    session: Pick<Session, "id" | "deviceId">,
  ): Promise<void> {
    const { deviceId } = session;
    const device = await this.store.getDevice(deviceId);
    if (!device) return;
    const ref = { id: deviceId, adbSerial: device.adbSerial };
    for (;;) {
      const endTimer = this.metrics.cleanupSeconds.startTimer();
      let ok = false;
      try {
        await withTimeout(
          this.adapter.cleanup(ref),
          this.config.cleanupTimeoutMs,
        );
        const health = await withTimeout(
          this.adapter.health(ref),
          this.config.cleanupTimeoutMs,
        );
        ok = health.healthy;
      } catch (err) {
        this.log.warn({
          event: "cleanup_attempt_failed",
          deviceId,
          err: String(err),
        });
      }
      endTimer();
      const res = await this.store.finishCleanup(
        session.id,
        deviceId,
        ok,
        this.clock.now(),
        this.config.maxDeviceFailures,
      );
      if (!res.ok) {
        this.log.warn({
          event: "cleanup_finish_skipped",
          deviceId,
          code: res.code,
        });
        return;
      }
      if (res.value === "AVAILABLE") {
        this.log.info({ event: "cleanup_completed", deviceId });
        void this.pump();
        void this.broadcastQueueAndPool();
        return;
      }
      if (res.value === "OFFLINE") {
        this.log.error({ event: "device_offline_after_cleanup", deviceId });
        void this.broadcastQueueAndPool();
        return;
      }
      await this.sleep(Math.min(this.config.cleanupTimeoutMs, 1000));
    }
  }

  // ---------------- reaper & health ----------------

  async reaperRunOnce(): Promise<void> {
    const now = this.clock.now();
    for (const sessionId of await this.store.listNonterminalSessionIds()) {
      const session = await this.store.getSession(sessionId);
      if (!session) continue;
      switch (session.state) {
        case "RESERVED":
          if (session.claimDeadline && now > session.claimDeadline) {
            this.metrics.recoveries.inc({ reason: "claim_timeout" });
            await this.terminateSession(sessionId, "claim_timeout", "EXPIRED");
          } else {
            await this.store.heartbeat(
              sessionId,
              null,
              now,
              this.config.leaseTtlMs,
            );
          }
          break;
        case "ACTIVE": {
          if (now > session.expiresAt) {
            this.metrics.recoveries.inc({ reason: "session_timeout" });
            await this.terminateSession(sessionId, "timeout", "EXPIRED");
            break;
          }
          if (now - session.lastHeartbeatAt > this.config.heartbeatTimeoutMs) {
            await this.store.markDisconnected(
              sessionId,
              now,
              now + this.config.reconnectGraceMs,
            );
            break;
          }
          await this.store.heartbeat(
            sessionId,
            null,
            now,
            this.config.leaseTtlMs,
          );
          break;
        }
        case "DISCONNECTED": {
          if (now > session.expiresAt) {
            this.metrics.recoveries.inc({ reason: "session_timeout" });
            await this.terminateSession(sessionId, "timeout", "EXPIRED");
            break;
          }
          if (session.reconnectDeadline && now > session.reconnectDeadline) {
            this.metrics.recoveries.inc({ reason: "abandoned" });
            await this.terminateSession(sessionId, "disconnect", "EXPIRED");
            break;
          }
          await this.store.heartbeat(
            sessionId,
            null,
            now,
            this.config.leaseTtlMs,
          );
          break;
        }
        case "ENDING":
        case "EXPIRED":
        case "CLEANING":
          // cleanupDevice owns these; nothing to do here.
          break;
        default:
          break;
      }
    }
    await this.refreshGauges();
  }

  private async attachRemoteDevices(): Promise<void> {
    for (const target of this.config.adbConnect) {
      try {
        await this.adapter.connect?.(target);
      } catch (err) {
        this.log.warn({
          event: "adb_connect_failed",
          target,
          err: String(err),
        });
      }
    }
  }

  async healthRunOnce(): Promise<void> {
    // Re-attach TCP devices that dropped (tunnels, remote phones).
    await this.attachRemoteDevices();
    for (const deviceId of await this.store.listDeviceIds()) {
      const device = await this.store.getDevice(deviceId);
      if (!device) continue;
      const health = await this.adapter.health({
        id: device.id,
        adbSerial: device.adbSerial,
      });
      // The transition runs as a Lua script so a concurrent allocation can
      // never be clobbered by a stale read-modify-write from this loop.
      const result = await this.store.healthUpdate(
        deviceId,
        health.healthy,
        this.clock.now(),
      );
      switch (result) {
        case "OFFLINE":
          this.log.warn({ event: "device_offline", deviceId });
          void this.broadcastQueueAndPool();
          break;
        case "RECOVERED":
          this.log.info({ event: "device_recovered", deviceId });
          void this.pump();
          void this.broadcastQueueAndPool();
          break;
        case "SESSION_UNHEALTHY": {
          const fresh = await this.store.getDevice(deviceId);
          if (fresh?.currentSessionId) {
            this.metrics.recoveries.inc({ reason: "device_error" });
            await this.terminateSession(
              fresh.currentSessionId,
              "device_error",
              "EXPIRED",
            );
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // ---------------- broadcasts & status ----------------

  async poolStatus(): Promise<PoolStatus> {
    const status: PoolStatus = {
      available: 0,
      inUse: 0,
      reserved: 0,
      cleaning: 0,
      offline: 0,
      queueDepth: await this.store.queueDepth(),
    };
    for (const deviceId of await this.store.listDeviceIds()) {
      const device = await this.store.getDevice(deviceId);
      switch (device?.state) {
        case "AVAILABLE":
          status.available += 1;
          break;
        case "IN_USE":
          status.inUse += 1;
          break;
        case "RESERVED":
          status.reserved += 1;
          break;
        case "CLEANING":
          status.cleaning += 1;
          break;
        case "OFFLINE":
          status.offline += 1;
          break;
      }
    }
    return status;
  }

  async positionOf(requestId: string): Promise<number> {
    const order = await this.store.queueOrder();
    const index = order.indexOf(requestId);
    return index === -1 ? 0 : index + 1;
  }

  async broadcastQueueAndPool(): Promise<void> {
    const pool = await this.poolStatus();
    const order = await this.store.queueOrder();
    for (let i = 0; i < order.length; i++) {
      const entry = await this.store.getQueueEntry(order[i]!);
      if (entry?.state === "WAITING") {
        this.transport.send(entry.clientId, {
          type: "queue.state",
          requestId: entry.requestId,
          position: i + 1,
          pool,
        });
      }
    }
    await this.refreshGauges();
  }

  private async refreshGauges(): Promise<void> {
    const pool = await this.poolStatus();
    this.metrics.devices.set({ state: "available" }, pool.available);
    this.metrics.devices.set({ state: "in_use" }, pool.inUse + pool.reserved);
    this.metrics.devices.set({ state: "cleaning" }, pool.cleaning);
    this.metrics.devices.set({ state: "offline" }, pool.offline);
    this.metrics.queueDepth.set(pool.queueDepth);
  }
}

function displayInfo(device: Device | null): DisplayInfo {
  return {
    deviceId: device?.id ?? "unknown",
    kind: device?.kind ?? "ANDROID_EMULATOR",
    width: device?.width ?? 720,
    height: device?.height ?? 1280,
    rotation: device?.rotation ?? 0,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
