import { describe, expect, it } from "vitest";
import { WsHub } from "../apps/server/src/realtime/hub.js";
import { LabMetrics } from "../apps/server/src/telemetry/metrics.js";
import type { LabCore } from "../apps/server/src/core.js";
import { JpegStreamParser } from "@lab/device-adapter";

const silentLog = {
  info: () => void 0,
  warn: () => void 0,
  error: () => void 0,
};

interface FakeWs {
  OPEN: number;
  readyState: number;
  bufferedAmount: number;
  sent: Uint8Array[];
  handlers: Record<string, (...args: unknown[]) => void>;
  send(data: unknown, _opts?: unknown): void;
  on(event: string, fn: (...args: unknown[]) => void): void;
  close(): void;
}

function fakeWs(): FakeWs {
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    handlers: {},
    send(data: unknown) {
      if (data instanceof Uint8Array) this.sent.push(data);
    },
    on(event, fn) {
      this.handlers[event] = fn;
    },
    close() {},
  };
}

async function counterValue(
  metrics: LabMetrics,
  name: string,
): Promise<number> {
  const metric = await metrics.registry.getSingleMetric(name)?.get();
  return metric?.values.reduce((sum, v) => sum + v.value, 0) ?? 0;
}

describe("latest-frame-wins backpressure", () => {
  it("slow client: pending frame is replaced by newer frames, memory stays bounded at one frame", async () => {
    const metrics = new LabMetrics(false);
    const hub = new WsHub(null as unknown as LabCore, metrics, silentLog, 1000);
    const ws = fakeWs();
    // register without touching core: reach into transport surface directly
    const state = {
      ws,
      clientToken: "t",
      clientId: "c1",
      pendingFrame: null,
      flushTimer: null,
      msgTimestamps: [],
    };
    // @ts-expect-error test reaches into the private socket map
    hub.sockets.set("c1", new Set([state]));

    // fast path while the buffer is empty
    hub.sendFrame("c1", new Uint8Array([1]));
    expect(ws.sent).toHaveLength(1);

    // saturate the socket: frames must not queue, only the latest is retained
    ws.bufferedAmount = 5000;
    for (let i = 2; i <= 100; i++) hub.sendFrame("c1", new Uint8Array([i]));
    expect(ws.sent).toHaveLength(1); // nothing else hit the wire
    expect(await counterValue(metrics, "lab_stream_frames_dropped_total")).toBe(
      98,
    );

    // drain: the flush timer sends exactly the newest frame
    ws.bufferedAmount = 0;
    await new Promise((r) => setTimeout(r, 100));
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[1]![0]).toBe(100);

    const sent = await counterValue(metrics, "lab_stream_frames_sent_total");
    expect(sent).toBe(2);
  });
});

describe("jpeg stream parser", () => {
  it("splits concatenated jpegs across chunk boundaries", () => {
    const frames: Buffer[] = [];
    const parser = new JpegStreamParser((f) => frames.push(f));
    const jpeg = (fill: number) =>
      Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.alloc(10, fill),
        Buffer.from([0xff, 0xd9]),
      ]);
    const stream = Buffer.concat([jpeg(1), jpeg(2), jpeg(3)]);
    // feed in awkward chunk sizes
    for (let i = 0; i < stream.length; i += 5) {
      parser.push(stream.subarray(i, Math.min(i + 5, stream.length)));
    }
    expect(frames).toHaveLength(3);
    expect(frames[0]![2]).toBe(1);
    expect(frames[2]![2]).toBe(3);
    for (const f of frames) {
      expect(f[0]).toBe(0xff);
      expect(f[1]).toBe(0xd8);
      expect(f[f.length - 1]).toBe(0xd9);
    }
  });
});
