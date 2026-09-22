/**
 * Four-client queue demonstration against a running server.
 *
 * Spawns four headless WebSocket clients: the first three should each obtain a
 * distinct device; the fourth waits at position 1. Client 1 then ends its
 * session and the script asserts the fourth client is served automatically.
 *
 * Usage: pnpm demo [wsBase]   (default ws://127.0.0.1:4000)
 */
import WebSocket from "ws";
import { randomBytes } from "node:crypto";

const base = process.argv[2] ?? "ws://127.0.0.1:4000";
const heartbeats = new Map<string, NodeJS.Timeout>();

interface DemoClient {
  name: string;
  ws: WebSocket;
  sessionId?: string;
  deviceId?: string;
  fence?: number;
  position?: number;
  frames: number;
  ended?: string;
}

function connect(name: string): Promise<DemoClient> {
  const clientToken = `demo-${name}-${randomBytes(12).toString("hex")}`;
  const ws = new WebSocket(`${base}/api/v1/ws?clientToken=${clientToken}`);
  const client: DemoClient = { name, ws, frames: 0 };
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      client.frames += 1;
      return;
    }
    const msg = JSON.parse(raw.toString());
    switch (msg.type) {
      case "session.reserved":
        ws.send(
          JSON.stringify({
            type: "session.claim",
            sessionId: msg.sessionId,
            claimToken: msg.claimToken,
          }),
        );
        break;
      case "session.active":
        client.sessionId = msg.sessionId;
        client.deviceId = msg.device.deviceId;
        client.fence = msg.fence;
        client.position = undefined;
        console.log(
          `[${name}] ACTIVE on ${msg.device.deviceId} (fence ${msg.fence})`,
        );
        if (!heartbeats.has(name)) {
          heartbeats.set(
            name,
            setInterval(() => {
              if (client.sessionId && ws.readyState === ws.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "session.heartbeat",
                    sessionId: client.sessionId,
                  }),
                );
              }
            }, 5000),
          );
        }
        break;
      case "queue.state":
        if (client.position !== msg.position) {
          client.position = msg.position;
          console.log(`[${name}] WAITING position ${msg.position}`);
        }
        break;
      case "session.ended":
        client.ended = msg.reason;
        console.log(`[${name}] ENDED (${msg.reason})`);
        break;
    }
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(client));
    ws.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  what: string,
  pred: () => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`);
    await sleep(100);
  }
}

async function main(): Promise<void> {
  console.log(`connecting 4 clients to ${base}`);
  const clients: DemoClient[] = [];
  for (const name of ["c1", "c2", "c3", "c4"]) {
    const client = await connect(name);
    clients.push(client);
    await sleep(150);
  }
  // request devices in order
  for (const client of clients) {
    const res = await fetch(`${base.replace(/^ws/, "http")}/api/v1/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientToken: (client.ws.url.match(/clientToken=([^&]+)/) ?? [])[1],
      }),
    });
    if (!res.ok)
      throw new Error(`request failed for ${client.name}: ${res.status}`);
    await sleep(300);
  }

  const [c1, c2, c3, c4] = clients as [
    DemoClient,
    DemoClient,
    DemoClient,
    DemoClient,
  ];
  await waitFor("three active sessions", () =>
    [c1, c2, c3].every((c) => c.sessionId),
  );
  const devices = new Set([c1.deviceId, c2.deviceId, c3.deviceId]);
  if (devices.size !== 3)
    throw new Error(`expected 3 distinct devices, got ${[...devices]}`);
  console.log("✔ three clients hold three distinct devices");

  await waitFor("c4 at position 1", () => c4.position === 1);
  console.log("✔ fourth client waiting at position 1");

  // induce a little motion so the change-driven stream emits frames
  let seq = 0;
  const sendSwipe = (fence: number) => {
    seq += 1;
    c1.ws.send(
      JSON.stringify({
        type: "input.command",
        sessionId: c1.sessionId,
        fence,
        seq,
        sentAt: Date.now(),
        payload: {
          kind: "swipe",
          from: { x: 0.5, y: 0.7 },
          to: { x: 0.5, y: 0.35 },
          durationMs: 250,
        },
      }),
    );
  };
  await waitFor(
    "streams flowing",
    () => {
      if (c1.frames === 0 && seq < 10 && c1.fence !== undefined)
        sendSwipe(c1.fence);
      return c1.frames > 0;
    },
    20_000,
  );
  console.log(`✔ frames flowing (c1 received ${c1.frames})`);

  console.log("-- c1 ends its session --");
  c1.ws.send(JSON.stringify({ type: "session.end", sessionId: c1.sessionId }));

  await waitFor("c4 served after release", () => Boolean(c4.sessionId), 60_000);
  console.log(`✔ c4 automatically served on ${c4.deviceId} after cleanup`);

  for (const t of heartbeats.values()) clearInterval(t);
  for (const c of clients) c.ws.close();
  console.log("\nDEMO OK: 3 active + 1 queued -> release -> automatic handoff");
  process.exit(0);
}

main().catch((err) => {
  console.error("DEMO FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
