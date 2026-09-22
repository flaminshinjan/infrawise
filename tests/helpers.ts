import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { FakeAdapter } from "@lab/device-adapter";
import type { ServerMessage } from "@lab/protocol";
import {
  loadConfig,
  type Clock,
  type LabConfig,
} from "../apps/server/src/config.js";
import {
  LabCore,
  clientIdFromToken,
  type ClientTransport,
  type Logger,
} from "../apps/server/src/core.js";
import { LabStore } from "../apps/server/src/scheduler/store.js";
import { LabMetrics } from "../apps/server/src/telemetry/metrics.js";

export class ManualClock implements Clock {
  private t = 1_000_000_000_000;

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}

export class CapturingTransport implements ClientTransport {
  messages = new Map<string, ServerMessage[]>();
  frames = new Map<string, Uint8Array[]>();

  send(clientId: string, message: ServerMessage): void {
    const list = this.messages.get(clientId) ?? [];
    list.push(message);
    this.messages.set(clientId, list);
  }

  sendFrame(clientId: string, data: Uint8Array): void {
    const list = this.frames.get(clientId) ?? [];
    list.push(data);
    this.frames.set(clientId, list);
  }

  of(clientId: string): ServerMessage[] {
    return this.messages.get(clientId) ?? [];
  }

  lastOfType<T extends ServerMessage["type"]>(
    clientId: string,
    type: T,
  ): Extract<ServerMessage, { type: T }> | undefined {
    const list = this.of(clientId).filter((m) => m.type === type);
    return list[list.length - 1] as
      Extract<ServerMessage, { type: T }> | undefined;
  }
}

const silentLogger: Logger = {
  info: () => void 0,
  warn: () => void 0,
  error: () => void 0,
};

export interface TestRedis {
  url: string;
  stop(): Promise<void>;
}

/** Spawn a disposable redis-server on a random port. */
export async function startRedis(): Promise<TestRedis> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc: ChildProcess = spawn(
      "redis-server",
      [
        "--port",
        String(port),
        "--save",
        "",
        "--appendonly",
        "no",
        "--bind",
        "127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const url = `redis://127.0.0.1:${port}`;
    const probe = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    const ok = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 3000;
      const tryPing = async () => {
        try {
          await probe.connect();
          await probe.ping();
          resolve(true);
        } catch {
          probe.disconnect();
          if (Date.now() > deadline) resolve(false);
          else setTimeout(tryPing, 100);
        }
      };
      void tryPing();
    });
    probe.disconnect();
    if (ok) {
      return {
        url,
        stop: async () => {
          proc.kill("SIGKILL");
        },
      };
    }
    proc.kill("SIGKILL");
  }
  throw new Error("could not start redis-server (is it installed?)");
}

export interface TestLab {
  core: LabCore;
  store: LabStore;
  adapter: FakeAdapter;
  clock: ManualClock;
  transport: CapturingTransport;
  config: LabConfig;
  redis: Redis;
  metrics: LabMetrics;
  /** simulate kill -9 + restart: fresh core over the same Redis state */
  restart(): Promise<TestLab>;
  close(): Promise<void>;
}

export async function makeLab(
  redisUrl: string,
  options: {
    devices?: number;
    config?: Partial<LabConfig>;
    clock?: ManualClock;
    adapter?: FakeAdapter;
    prefix?: string;
  } = {},
): Promise<TestLab> {
  const prefix = options.prefix ?? `test:${randomBytes(6).toString("hex")}:`;
  const deviceCount = options.devices ?? 3;
  const serials = Array.from(
    { length: deviceCount },
    (_, i) => `fake-${i + 1}`,
  );
  const adapter = options.adapter ?? new FakeAdapter();
  if (!options.adapter) {
    for (const serial of serials) adapter.addDevice({ adbSerial: serial });
  }
  const clock = options.clock ?? new ManualClock();
  const config = loadConfig({
    redisUrl,
    redisKeyPrefix: prefix,
    deviceSerials: serials,
    sessionMaxMs: 600_000,
    reservationClaimMs: 10_000,
    heartbeatTimeoutMs: 15_000,
    reconnectGraceMs: 15_000,
    cleanupTimeoutMs: 2_000,
    leaseTtlMs: 15_000,
    ...options.config,
  });
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    retryStrategy: () => null,
  });
  redis.on("error", () => void 0);
  const store = new LabStore(redis, prefix);
  const metrics = new LabMetrics(false);
  const transport = new CapturingTransport();
  const core = new LabCore(
    store,
    adapter,
    config,
    metrics,
    transport,
    silentLogger,
    clock,
    () => Promise.resolve(),
  );
  await core.bootstrap();

  const lab: TestLab = {
    core,
    store,
    adapter,
    clock,
    transport,
    config,
    redis,
    metrics,
    restart: async () => {
      // kill -9 semantics: nothing is flushed or stopped; just build a new
      // process view over the same durable state.
      redis.disconnect();
      return makeLab(redisUrl, { ...options, prefix, clock, adapter });
    },
    close: async () => {
      await core.stop();
      redis.disconnect();
    },
  };
  return lab;
}

export function token(name: string): string {
  return `client-token-${name}-0123456789abcdef`;
}

export function cid(name: string): string {
  return clientIdFromToken(token(name)).clientId;
}

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Drive a client through request -> reserved -> claimed(active). */
export async function requestAndActivate(
  lab: TestLab,
  name: string,
): Promise<string> {
  await lab.core.createRequest(token(name));
  await lab.core.pump();
  const reserved = lab.transport.lastOfType(cid(name), "session.reserved");
  if (!reserved) throw new Error(`client ${name} was not reserved`);
  const res = await lab.core.claimSession(
    token(name),
    reserved.sessionId,
    reserved.claimToken,
  );
  if (!res.ok) throw new Error(`claim failed: ${res.error}`);
  return reserved.sessionId;
}
