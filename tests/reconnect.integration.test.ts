import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cid,
  makeLab,
  requestAndActivate,
  startRedis,
  token,
  waitFor,
  type TestRedis,
} from "./helpers.js";

let redis: TestRedis;

beforeAll(async () => {
  redis = await startRedis();
});

afterAll(async () => {
  await redis.stop();
});

describe("refresh and reconnect", () => {
  it("reconnect inside grace restores the same session and sequence state", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const sessionId = await requestAndActivate(lab, "ref");
    const fence = (await lab.store.getSession(sessionId))!.leaseFence;

    // apply one input so sequence state exists
    lab.core.handleInput(token("ref"), {
      type: "input.command",
      sessionId,
      fence,
      seq: 1,
      sentAt: Date.now(),
      payload: { kind: "key", key: "HOME" },
    });
    await waitFor(
      async () =>
        (await lab.store.getSession(sessionId))!.lastAcceptedInputSeq === 1,
    );

    await lab.core.clientDisconnected(token("ref"));
    expect((await lab.store.getSession(sessionId))!.state).toBe("DISCONNECTED");

    lab.clock.advance(5_000); // inside 15s grace
    const snapshot = await lab.core.clientConnected(token("ref"));
    expect(snapshot.status).toBe("ACTIVE");
    if (snapshot.status === "ACTIVE") {
      expect(snapshot.sessionId).toBe(sessionId);
      expect(snapshot.lastAcceptedInputSeq).toBe(1);
      expect(snapshot.fence).toBe(fence);
    }
    expect((await lab.store.getSession(sessionId))!.state).toBe("ACTIVE");
    await lab.close();
  });

  it("refresh while waiting reconnects to the same queue entry", async () => {
    const lab = await makeLab(redis.url, { devices: 0 });
    const first = await lab.core.createRequest(token("waiter"));
    expect(first.status).toBe("WAITING");
    const snapshot = await lab.core.clientConnected(token("waiter"));
    expect(snapshot.status).toBe("WAITING");
    if (first.status === "WAITING" && snapshot.status === "WAITING") {
      expect(snapshot.requestId).toBe(first.requestId);
    }
    await lab.close();
  });

  it("abandoned tab: grace expiry ends the session, cleans, and serves the next waiter", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const sessionId = await requestAndActivate(lab, "gone");
    await lab.core.createRequest(token("next"));

    await lab.core.clientDisconnected(token("gone"));
    lab.clock.advance(16_000); // past grace
    await lab.core.reaperRunOnce();

    await waitFor(
      async () => (await lab.store.getSession(sessionId))!.state === "ENDED",
    );
    expect((await lab.store.getSession(sessionId))!.endReason).toBe(
      "disconnect",
    );
    // cleanup ran before reassignment
    expect(
      lab.adapter.callsOf("cleanup", "fake-1").length,
    ).toBeGreaterThanOrEqual(1);
    await waitFor(
      () =>
        lab.transport.lastOfType(cid("next"), "session.reserved") !== undefined,
    );

    // late reconnect attempt gets no session back
    const snapshot = await lab.core.clientConnected(token("gone"));
    expect(snapshot.status).toBe("IDLE");
    await lab.close();
  });

  it("stale heartbeat with an open socket also triggers grace then expiry", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const sessionId = await requestAndActivate(lab, "hung");
    lab.clock.advance(16_000); // no heartbeats for > HEARTBEAT_TIMEOUT_MS
    await lab.core.reaperRunOnce();
    expect((await lab.store.getSession(sessionId))!.state).toBe("DISCONNECTED");
    lab.clock.advance(16_000);
    await lab.core.reaperRunOnce();
    await waitFor(
      async () => (await lab.store.getSession(sessionId))!.state === "ENDED",
    );
    await lab.close();
  });

  it("maximum session duration is enforced server-side", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const sessionId = await requestAndActivate(lab, "marathon");
    const fence = (await lab.store.getSession(sessionId))!.leaseFence;
    await lab.core.createRequest(token("после"));

    lab.clock.advance(600_001);
    await lab.core.reaperRunOnce();
    await waitFor(
      async () => (await lab.store.getSession(sessionId))!.state === "ENDED",
    );
    expect((await lab.store.getSession(sessionId))!.endReason).toBe("timeout");

    // input against the expired session is rejected
    const taps = lab.adapter.callsOf("tap").length;
    lab.core.handleInput(token("marathon"), {
      type: "input.command",
      sessionId,
      fence,
      seq: 1,
      sentAt: Date.now(),
      payload: { kind: "tap", point: { x: 0.1, y: 0.1 } },
    });
    await waitFor(() =>
      lab.transport
        .of(cid("marathon"))
        .some((m) => m.type === "input.ack" && m.status === "rejected"),
    );
    expect(lab.adapter.callsOf("tap")).toHaveLength(taps);

    // queue progressed to the waiter
    await waitFor(
      () =>
        lab.transport.lastOfType(cid("после"), "session.reserved") !==
        undefined,
    );
    await lab.close();
  });
});
