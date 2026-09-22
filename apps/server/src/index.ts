import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { Redis } from "ioredis";
import { AdbAndroidAdapter } from "@lab/device-adapter";
import { loadConfig } from "./config.js";
import { clientIdFromToken, LabCore, type ClientTransport } from "./core.js";
import { registerRoutes } from "./api/routes.js";
import { WsHub } from "./realtime/hub.js";
import { LabStore } from "./scheduler/store.js";
import { LabMetrics } from "./telemetry/metrics.js";

const config = loadConfig();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: ["req.url", "req.headers"],
  },
  disableRequestLogging: true,
});

const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
});
const store = new LabStore(redis, config.redisKeyPrefix);
const metrics = new LabMetrics();
const adapter = new AdbAndroidAdapter({
  maxTextLength: config.inputMaxTextLength,
});

// transport is swapped for the real hub right after core construction
const nullTransport: ClientTransport = {
  send: () => void 0,
  sendFrame: () => void 0,
};
const core = new LabCore(
  store,
  adapter,
  config,
  metrics,
  nullTransport,
  app.log,
);
const hub = new WsHub(core, metrics, app.log, config.streamMaxBufferedBytes);
core.setTransport(hub);

let ready = false;

async function main(): Promise<void> {
  await redis.connect();
  if (config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: config.corsOrigins,
      methods: ["GET", "POST", "DELETE"],
      allowedHeaders: ["content-type", "x-client-token"],
    });
  }
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.get("/api/v1/ws", { websocket: true }, (socket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const clientToken = url.searchParams.get("clientToken") ?? "";
    if (clientToken.length < 16 || clientToken.length > 128) {
      socket.close(4001, "invalid clientToken");
      return;
    }
    const { clientId } = clientIdFromToken(clientToken);
    void hub.register(socket, clientToken, clientId).catch((err) => {
      app.log.error({ event: "ws_register_failed", err: String(err) });
      socket.close(1011, "internal error");
    });
  });

  registerRoutes(app, core, metrics, () => ready, config);

  // Serve the built web UI when present (dev uses the Vite server + proxy).
  const webDist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../web/dist",
  );
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
  }

  await core.bootstrap();
  core.start();
  ready = true;

  await app.listen({ port: config.port, host: config.host });
  app.log.info({
    event: "server_started",
    port: config.port,
    devices: config.deviceSerials,
  });
}

// Graceful shutdown is a convenience only; correctness never depends on it
// (see recovery/reconcile + the reaper for the kill -9 path).
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
async function shutdown(): Promise<void> {
  ready = false;
  await core.stop().catch(() => void 0);
  await app.close().catch(() => void 0);
  redis.disconnect();
  process.exit(0);
}

main().catch((err) => {
  app.log.error({ event: "fatal", err: String(err) });
  process.exit(1);
});
