import { z } from "zod";
import type { DeviceState, DisplayInfo, PoolStatus } from "./domain.js";

// ---------- Input payloads (client -> server) ----------

export const NormalizedPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type NormalizedPoint = z.infer<typeof NormalizedPointSchema>;

export const MAX_TEXT_LENGTH_HARD = 2000;

/**
 * Apps/screens the lab can launch by name. The wire carries only this enum,
 * never a free-form package or shell string — the adapter maps each id to an
 * explicit, injection-safe `am start` argument array.
 */
export const LAUNCH_APP_IDS = [
  "settings",
  "wifi_settings",
  "bluetooth_settings",
  "display_settings",
  "app_settings",
  "chrome",
  "camera",
  "clock",
  "phone",
  "contacts",
  "messages",
  "calculator",
  "gmail",
  "maps",
  "photos",
  "play_store",
  "files",
  "app_drawer",
] as const;
export type LaunchAppId = (typeof LAUNCH_APP_IDS)[number];

export const InputPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tap"), point: NormalizedPointSchema }),
  z.object({
    kind: z.literal("swipe"),
    from: NormalizedPointSchema,
    to: NormalizedPointSchema,
    durationMs: z.number().int().min(20).max(5000),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1).max(MAX_TEXT_LENGTH_HARD),
  }),
  z.object({ kind: z.literal("key"), key: z.enum(["BACK", "HOME"]) }),
  z.object({ kind: z.literal("launch"), app: z.enum(LAUNCH_APP_IDS) }),
]);
export type InputPayload = z.infer<typeof InputPayloadSchema>;

/**
 * A compiled test step: one input command or a wait. Both the client-side
 * parser and the server-side LLM compiler emit this shape, so the chat pane
 * executes either identically. `label` is a short human summary for the
 * transcript.
 */
export const TestStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("input"),
    payload: InputPayloadSchema,
    label: z.string().min(1).max(80),
  }),
  z.object({
    kind: z.literal("wait"),
    ms: z.number().int().min(50).max(30_000),
    label: z.string().min(1).max(80),
  }),
]);
export type TestStep = z.infer<typeof TestStepSchema>;

export const CompileRequestSchema = z.object({
  text: z.string().min(1).max(600),
});
export interface CompileResponse {
  ok: boolean;
  steps: TestStep[];
  note?: string;
  error?: string;
  source: "llm";
}

export const InputCommandSchema = z.object({
  type: z.literal("input.command"),
  sessionId: z.string().max(64),
  fence: z.number().int().nonnegative(),
  seq: z.number().int().positive(),
  sentAt: z.number(),
  payload: InputPayloadSchema,
});
export type InputCommand = z.infer<typeof InputCommandSchema>;

// ---------- Client -> server control messages ----------

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.claim"),
    sessionId: z.string().max(64),
    claimToken: z.string().max(128),
  }),
  z.object({
    type: z.literal("session.heartbeat"),
    sessionId: z.string().max(64),
  }),
  InputCommandSchema,
  z.object({ type: z.literal("session.end"), sessionId: z.string().max(64) }),
  z.object({
    type: z.literal("stream.feedback"),
    sessionId: z.string().max(64),
    renderedSeq: z.number().int().nonnegative(),
    renderedAt: z.number(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------- Server -> client messages ----------

export interface InputAck {
  type: "input.ack";
  sessionId: string;
  seq: number;
  status: "applied" | "duplicate" | "rejected";
  appliedAt?: number;
  reason?: string;
  expectedSeq?: number;
}

export type ServerMessage =
  | { type: "hello"; state: ClientStateSnapshot; pool: PoolStatus }
  | {
      type: "queue.state";
      requestId: string;
      position: number;
      pool: PoolStatus;
    }
  | {
      type: "session.reserved";
      sessionId: string;
      claimToken: string;
      claimBy: number;
    }
  | {
      type: "session.active";
      sessionId: string;
      device: DisplayInfo;
      fence: number;
      expiresAt: number;
      lastAcceptedInputSeq: number;
    }
  | { type: "session.ended"; sessionId: string; reason: string }
  | { type: "device.state"; deviceId: string; state: DeviceState }
  | { type: "pool.state"; pool: PoolStatus }
  | InputAck
  | { type: "error"; code: string; message: string };

// ---------- HTTP shapes ----------

export const CreateRequestSchema = z.object({
  clientToken: z.string().min(16).max(128),
});

export type ClientStateSnapshot =
  | { status: "IDLE" }
  | {
      status: "WAITING";
      requestId: string;
      position: number;
      enqueuedAt: number;
    }
  | { status: "RESERVED"; sessionId: string; claimBy: number }
  | {
      status: "ACTIVE";
      sessionId: string;
      device: DisplayInfo;
      fence: number;
      expiresAt: number;
      lastAcceptedInputSeq: number;
    };
