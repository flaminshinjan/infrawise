import type { FastifyInstance } from "fastify";
import { CompileRequestSchema, CreateRequestSchema } from "@lab/protocol";
import { z } from "zod";
import type { LabCore } from "../core.js";
import type { LabConfig } from "../config.js";
import { compileWithLlm } from "../nl/compile.js";
import type { LabMetrics } from "../telemetry/metrics.js";

const TokenHeaderSchema = z.string().min(16).max(128);

/** Small fixed-window rate limiter keyed by IP. */
class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart > this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }
}

export function registerRoutes(
  app: FastifyInstance,
  core: LabCore,
  metrics: LabMetrics,
  isReady: () => boolean,
  config: LabConfig,
): void {
  const requestLimiter = new RateLimiter(10, 10_000);
  const compileLimiter = new RateLimiter(20, 60_000);

  app.addHook("onSend", (_req, reply, payload, done) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    done(null, payload);
  });

  const tokenFrom = (headers: Record<string, unknown>): string | null => {
    const parsed = TokenHeaderSchema.safeParse(headers["x-client-token"]);
    return parsed.success ? parsed.data : null;
  };

  app.post("/api/v1/requests", async (req, reply) => {
    if (!requestLimiter.allow(req.ip)) {
      return reply.code(429).send({ error: "rate limited" });
    }
    const parsed = CreateRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    const snapshot = await core.createRequest(parsed.data.clientToken);
    switch (snapshot.status) {
      case "WAITING":
        return {
          status: "WAITING",
          requestId: snapshot.requestId,
          position: snapshot.position,
        };
      case "RESERVED":
        // claimToken travels over the WebSocket session.reserved message; the
        // HTTP response only reports the reservation exists.
        return {
          status: "RESERVED",
          sessionId: snapshot.sessionId,
          claimBy: snapshot.claimBy,
        };
      case "ACTIVE":
        return { status: "ACTIVE", sessionId: snapshot.sessionId };
      default:
        return { status: "IDLE" };
    }
  });

  app.get("/api/v1/me/state", async (req, reply) => {
    const token = tokenFrom(req.headers);
    if (!token)
      return reply.code(401).send({ error: "missing x-client-token" });
    return core.getState(token);
  });

  app.post("/api/v1/sessions/:id/claim", async (req, reply) => {
    const token = tokenFrom(req.headers);
    if (!token)
      return reply.code(401).send({ error: "missing x-client-token" });
    const body = z
      .object({ claimToken: z.string().min(8).max(128) })
      .safeParse(req.body);
    const params = z.object({ id: z.string().max(64) }).safeParse(req.params);
    if (!body.success || !params.success)
      return reply.code(400).send({ error: "invalid request" });
    const res = await core.claimSession(
      token,
      params.data.id,
      body.data.claimToken,
    );
    if (!res.ok) return reply.code(409).send({ error: res.error });
    return { ok: true };
  });

  app.delete("/api/v1/requests/:id", async (req, reply) => {
    const token = tokenFrom(req.headers);
    if (!token)
      return reply.code(401).send({ error: "missing x-client-token" });
    const params = z.object({ id: z.string().max(64) }).safeParse(req.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid request" });
    const ok = await core.cancelRequest(token, params.data.id);
    return { ok };
  });

  app.delete("/api/v1/sessions/:id", async (req, reply) => {
    const token = tokenFrom(req.headers);
    if (!token)
      return reply.code(401).send({ error: "missing x-client-token" });
    const params = z.object({ id: z.string().max(64) }).safeParse(req.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid request" });
    await core.endSession(token, params.data.id);
    // idempotent: ending an already-ended session is success
    return { ok: true };
  });

  app.post("/api/v1/compile", async (req, reply) => {
    const token = tokenFrom(req.headers);
    if (!token)
      return reply.code(401).send({ error: "missing x-client-token" });
    if (!config.openaiApiKey) {
      return reply
        .code(501)
        .send({ ok: false, error: "AI compiler not enabled", source: "llm" });
    }
    if (!compileLimiter.allow(req.ip)) {
      return reply
        .code(429)
        .send({ ok: false, error: "rate limited — slow down", source: "llm" });
    }
    const parsed = CompileRequestSchema.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ ok: false, error: "invalid body", source: "llm" });
    const result = await compileWithLlm(parsed.data.text, {
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
    });
    return result;
  });

  app.get("/api/v1/healthz", async () => ({ ok: true }));

  app.get("/api/v1/readyz", async (_req, reply) => {
    try {
      await core.store.redis.ping();
    } catch {
      return reply.code(503).send({ ok: false, redis: false });
    }
    if (!isReady())
      return reply.code(503).send({ ok: false, reconciled: false });
    return { ok: true };
  });

  app.get("/api/v1/devices", async () => {
    const devices = [];
    for (const deviceId of await core.store.listDeviceIds()) {
      const d = await core.store.getDevice(deviceId);
      if (!d) continue;
      devices.push({
        id: d.id,
        kind: d.kind,
        state: d.state,
        width: d.width,
        height: d.height,
        lastHealthAt: d.lastHealthAt,
      });
    }
    devices.sort((a, b) => a.id.localeCompare(b.id));
    return { devices, pool: await core.poolStatus() };
  });

  app.get("/api/v1/events", async (req) => {
    const query = z
      .object({ count: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query ?? {});
    return { events: await core.store.recentEvents(query.count) };
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}
