/**
 * Measures real performance through the full stack (server + emulators):
 *
 *  - delivered FPS per stream during induced motion (1 stream and 3 streams)
 *  - frame capture -> client receive latency (same-host clocks)
 *  - tap -> visible-change latency: with an idle screen, screenrecord emits a
 *    frame only when pixels change, so the first frame captured after a tap is
 *    that tap's visual effect. Measured from input send to frame arrival.
 *    (Excludes browser decode/paint; includes capture, encode, transport.)
 *  - input command RTT (send -> applied ack, includes ADB execution)
 *  - allocation latency (POST /requests -> session.reserved over WS)
 *  - server process CPU%/RSS sampled during streaming
 *
 * Writes bench-results/results.json and prints a markdown table.
 *
 * Usage: pnpm benchmark [httpBase]   (default http://127.0.0.1:4000)
 */
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { decodeFrameHeader } from "@lab/protocol";

const httpBase = process.argv[2] ?? "http://127.0.0.1:4000";
const wsBase = httpBase.replace(/^http/, "ws");

interface BenchClient {
  name: string;
  token: string;
  ws: WebSocket;
  sessionId?: string;
  fence?: number;
  deviceId?: string;
  seq: number;
  frames: { at: number; capturedAt: number }[];
  reservedAt?: number;
  requestedAt?: number;
  acks: Map<number, { sentAt: number; ackedAt?: number }>;
  collect: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

async function connect(name: string): Promise<BenchClient> {
  const token = `bench-${name}-${randomBytes(12).toString("hex")}`;
  const ws = new WebSocket(`${wsBase}/api/v1/ws?clientToken=${token}`);
  ws.binaryType = "nodebuffer";
  const client: BenchClient = {
    name,
    token,
    ws,
    seq: 0,
    frames: [],
    acks: new Map(),
    collect: false,
  };
  ws.on("message", (raw, isBinary) => {
    const now = Date.now();
    if (isBinary) {
      const buf = raw as Buffer;
      const meta = decodeFrameHeader(
        buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        ) as ArrayBuffer,
      );
      if (client.collect && meta)
        client.frames.push({ at: now, capturedAt: meta.capturedAt });
      return;
    }
    const msg = JSON.parse(raw.toString());
    if (msg.type === "session.reserved") {
      client.reservedAt = now;
      ws.send(
        JSON.stringify({
          type: "session.claim",
          sessionId: msg.sessionId,
          claimToken: msg.claimToken,
        }),
      );
    } else if (msg.type === "session.active") {
      client.sessionId = msg.sessionId;
      client.fence = msg.fence;
      client.deviceId = msg.device.deviceId;
      client.seq = msg.lastAcceptedInputSeq;
    } else if (msg.type === "input.ack") {
      const entry = client.acks.get(msg.seq);
      if (entry) entry.ackedAt = now;
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  return client;
}

async function requestDevice(client: BenchClient): Promise<void> {
  client.requestedAt = Date.now();
  const res = await fetch(`${httpBase}/api/v1/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientToken: client.token }),
  });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  const deadline = Date.now() + 30_000;
  while (!client.sessionId) {
    if (Date.now() > deadline)
      throw new Error(`${client.name} never became active`);
    await sleep(50);
  }
}

function sendInput(client: BenchClient, payload: unknown): number {
  client.seq += 1;
  client.acks.set(client.seq, { sentAt: Date.now() });
  client.ws.send(
    JSON.stringify({
      type: "input.command",
      sessionId: client.sessionId,
      fence: client.fence,
      seq: client.seq,
      sentAt: Date.now(),
      payload,
    }),
  );
  return client.seq;
}

/** swipe loop to keep pixels changing while measuring FPS */
async function induceMotion(
  client: BenchClient,
  durationMs: number,
): Promise<void> {
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    sendInput(client, {
      kind: "swipe",
      from: { x: 0.5, y: 0.75 },
      to: { x: 0.5, y: 0.3 },
      durationMs: 300,
    });
    await sleep(450);
    sendInput(client, {
      kind: "swipe",
      from: { x: 0.5, y: 0.3 },
      to: { x: 0.5, y: 0.75 },
      durationMs: 300,
    });
    await sleep(450);
  }
}

function serverStats(): { cpu: number; rssMb: number } | null {
  try {
    // tsx watch runs the server in a child node process; take the
    // highest-CPU process whose command line mentions the entrypoint.
    const out = execFileSync("bash", [
      "-c",
      `ps -Ao pcpu,rss,command | grep 'src/index.ts' | grep -v grep | sort -k1 -nr | head -1`,
    ])
      .toString()
      .trim();
    if (!out) return null;
    const [cpu, rss] = out.split(/\s+/);
    return { cpu: Number(cpu), rssMb: Math.round(Number(rss) / 1024) };
  } catch {
    return null;
  }
}

interface StreamMeasurement {
  streams: number;
  deliveredFps: number;
  captureToReceiveP50: number;
  captureToReceiveP95: number;
  inputRttP50: number;
  inputRttP95: number;
  serverCpu: number | null;
  serverRssMb: number | null;
}

async function measureStreams(
  clients: BenchClient[],
  seconds: number,
): Promise<StreamMeasurement> {
  for (const c of clients) {
    c.frames = [];
    c.collect = true;
  }
  const cpuSamples: number[] = [];
  const rssSamples: number[] = [];
  const sampler = setInterval(() => {
    const s = serverStats();
    if (s) {
      cpuSamples.push(s.cpu);
      rssSamples.push(s.rssMb);
    }
  }, 1000);
  await Promise.all(clients.map((c) => induceMotion(c, seconds * 1000)));
  clearInterval(sampler);
  for (const c of clients) c.collect = false;

  const perClientFps = clients.map((c) => c.frames.length / seconds);
  const latencies = clients.flatMap((c) =>
    c.frames.map((f) => f.at - f.capturedAt),
  );
  const rtts = clients.flatMap((c) =>
    [...c.acks.values()]
      .filter((a) => a.ackedAt)
      .map((a) => a.ackedAt! - a.sentAt),
  );
  return {
    streams: clients.length,
    deliveredFps: Number(
      (perClientFps.reduce((a, b) => a + b, 0) / clients.length).toFixed(1),
    ),
    captureToReceiveP50: Math.round(quantile(latencies, 0.5)),
    captureToReceiveP95: Math.round(quantile(latencies, 0.95)),
    inputRttP50: Math.round(quantile(rtts, 0.5)),
    inputRttP95: Math.round(quantile(rtts, 0.95)),
    serverCpu: cpuSamples.length
      ? Number(quantile(cpuSamples, 0.5).toFixed(1))
      : null,
    serverRssMb: rssSamples.length
      ? Math.round(quantile(rssSamples, 0.5))
      : null,
  };
}

/** tap -> first frame captured after the tap (idle screen between samples) */
async function measureTapToPixel(
  client: BenchClient,
  samples: number,
): Promise<number[]> {
  const results: number[] = [];
  await sleep(2500); // let the screen go fully idle
  for (let i = 0; i < samples; i++) {
    client.frames = [];
    client.collect = true;
    const sentAt = Date.now();
    // alternating taps on the home screen produce a visible response
    // (icon press ripple / app drawer) without navigating anywhere permanent
    sendInput(client, { kind: "key", key: "HOME" });
    const deadline = Date.now() + 4000;
    let arrival: number | null = null;
    while (Date.now() < deadline) {
      const frame = client.frames.find((f) => f.capturedAt >= sentAt);
      if (frame) {
        arrival = frame.at;
        break;
      }
      await sleep(5);
    }
    client.collect = false;
    if (arrival !== null) results.push(arrival - sentAt);
    await sleep(1500); // return to idle
  }
  return results;
}

async function main(): Promise<void> {
  mkdirSync("bench-results", { recursive: true });
  console.log(`benchmark against ${httpBase}`);

  const c1 = await connect("s1");
  const allocStart = Date.now();
  await requestDevice(c1);
  const allocationMs = (c1.reservedAt ?? Date.now()) - allocStart;
  console.log(`c1 active on ${c1.deviceId} (allocation ${allocationMs}ms)`);

  console.log("measuring 1 stream (12s motion)…");
  const one = await measureStreams([c1], 12);
  console.log(one);

  console.log("measuring tap -> visible-change latency (30 samples)…");
  const tapLatencies = await measureTapToPixel(c1, 30);
  const tap = {
    samples: tapLatencies.length,
    p50: Math.round(quantile(tapLatencies, 0.5)),
    p95: Math.round(quantile(tapLatencies, 0.95)),
  };
  console.log(tap);

  console.log("adding two more streams…");
  const c2 = await connect("s2");
  const c3 = await connect("s3");
  await requestDevice(c2);
  await requestDevice(c3);
  console.log(`c2 on ${c2.deviceId}, c3 on ${c3.deviceId}`);

  console.log("measuring 3 streams (12s motion)…");
  const three = await measureStreams([c1, c2, c3], 12);
  console.log(three);

  console.log("measuring tap latency under 3-stream load (15 samples)…");
  const tapLoaded = await measureTapToPixel(c1, 15);
  const tap3 = {
    samples: tapLoaded.length,
    p50: Math.round(quantile(tapLoaded, 0.5)),
    p95: Math.round(quantile(tapLoaded, 0.95)),
  };
  console.log(tap3);

  const env = {
    machine: execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"])
      .toString()
      .trim(),
    cores: Number(execFileSync("sysctl", ["-n", "hw.ncpu"]).toString().trim()),
    os: `macOS ${execFileSync("sw_vers", ["-productVersion"]).toString().trim()}`,
    emulator:
      "3x Android 14 (API 34) arm64 AVD, 720x1280@320dpi, swiftshader, headless",
    stream:
      "adb screenrecord H.264 -> ffmpeg MJPEG (q7) -> WS binary, latest-frame-wins",
    date: new Date().toISOString(),
  };

  const results = { env, allocationMs, one, tap, three, tap3 };
  writeFileSync("bench-results/results.json", JSON.stringify(results, null, 2));

  const md = `
| Metric | 1 stream | 3 streams | Test environment |
|---|---:|---:|---|
| Delivered FPS (motion) | ${one.deliveredFps} | ${three.deliveredFps} | ${env.machine}, ${env.os} |
| Encode-out->client p50* | ${one.captureToReceiveP50} ms | ${three.captureToReceiveP50} ms | ${env.emulator} |
| Encode-out->client p95* | ${one.captureToReceiveP95} ms | ${three.captureToReceiveP95} ms | same |
| Tap->visible-change p50 | ${tap.p50} ms | ${tap3.p50} ms | ${tap.samples}/${tap3.samples} samples |
| Tap->visible-change p95 | ${tap.p95} ms | ${tap3.p95} ms | same |
| Input RTT p50 (ADB apply) | ${one.inputRttP50} ms | ${three.inputRttP50} ms | same |
| Server CPU (median) | ${one.serverCpu}% | ${three.serverCpu}% | server process only |
| Server RSS (median) | ${one.serverRssMb} MB | ${three.serverRssMb} MB | same |
| Allocation time | ${allocationMs} ms | — | request -> reservation |

\\* frame timestamps are applied when ffmpeg emits the JPEG, so this column
measures server-egress to client-receive on the same host; the full
capture-to-glass cost is captured by the tap-to-visible-change rows.
`;
  writeFileSync("bench-results/results.md", md.trim() + "\n");
  console.log(md);

  for (const c of [c1, c2, c3]) {
    c.ws.send(JSON.stringify({ type: "session.end", sessionId: c.sessionId }));
    await sleep(200);
    c.ws.close();
  }
  console.log("results written to bench-results/");
  process.exit(0);
}

main().catch((err) => {
  console.error("BENCHMARK FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
