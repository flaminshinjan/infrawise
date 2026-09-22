import { z } from "zod";
import type { DeviceState, DisplayInfo, PoolStatus } from "./domain.js";

// ---------- Input payloads (client -> server) ----------

export const NormalizedPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type NormalizedPoint = z.infer<typeof NormalizedPointSchema>;

export const MAX_TEXT_LENGTH_HARD = 2000;

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
]);
export type InputPayload = z.infer<typeof InputPayloadSchema>;

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
