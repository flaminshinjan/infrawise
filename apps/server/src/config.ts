export interface LabConfig {
  port: number;
  host: string;
  redisUrl: string;
  redisKeyPrefix: string;
  deviceSerials: string[];
  /** host:port targets to `adb connect` at boot and re-attach in the health loop */
  adbConnect: string[];
  corsOrigins: string[];
  sessionMaxMs: number;
  reservationClaimMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  reconnectGraceMs: number;
  cleanupTimeoutMs: number;
  deviceHealthIntervalMs: number;
  reaperIntervalMs: number;
  leaseTtlMs: number;
  streamMode: "auto" | "screenrecord" | "screencap";
  streamFps: number;
  streamJpegQuality: number;
  streamMaxBufferedBytes: number;
  inputMaxTextLength: number;
  inputMaxPending: number;
  /** bounded retries before a device is marked OFFLINE */
  maxDeviceFailures: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`invalid ${name}=${raw}`);
  return value;
}

export function loadConfig(overrides: Partial<LabConfig> = {}): LabConfig {
  const streamMode = (process.env.STREAM_MODE ??
    "auto") as LabConfig["streamMode"];
  return {
    port: intEnv("PORT", 4000),
    host: process.env.HOST ?? "127.0.0.1",
    redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    redisKeyPrefix: process.env.REDIS_KEY_PREFIX ?? "lab:",
    deviceSerials: (
      process.env.DEVICE_SERIALS ?? "emulator-5554,emulator-5556,emulator-5558"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    adbConnect: (process.env.ADB_CONNECT ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    corsOrigins: (process.env.CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    sessionMaxMs: intEnv("SESSION_MAX_MS", 600_000),
    reservationClaimMs: intEnv("RESERVATION_CLAIM_MS", 10_000),
    heartbeatIntervalMs: intEnv("HEARTBEAT_INTERVAL_MS", 5_000),
    heartbeatTimeoutMs: intEnv("HEARTBEAT_TIMEOUT_MS", 15_000),
    reconnectGraceMs: intEnv("RECONNECT_GRACE_MS", 15_000),
    cleanupTimeoutMs: intEnv("CLEANUP_TIMEOUT_MS", 30_000),
    deviceHealthIntervalMs: intEnv("DEVICE_HEALTH_INTERVAL_MS", 5_000),
    reaperIntervalMs: intEnv("REAPER_INTERVAL_MS", 2_000),
    leaseTtlMs: intEnv("LEASE_TTL_MS", 15_000),
    streamMode: ["auto", "screenrecord", "screencap"].includes(streamMode)
      ? streamMode
      : "auto",
    streamFps: intEnv("STREAM_FPS", 15),
    streamJpegQuality: intEnv("STREAM_JPEG_QUALITY", 7),
    streamMaxBufferedBytes: intEnv("STREAM_MAX_BUFFERED_BYTES", 1_000_000),
    inputMaxTextLength: intEnv("INPUT_MAX_TEXT_LENGTH", 512),
    inputMaxPending: intEnv("INPUT_MAX_PENDING", 32),
    maxDeviceFailures: intEnv("MAX_DEVICE_FAILURES", 3),
    ...overrides,
  };
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
