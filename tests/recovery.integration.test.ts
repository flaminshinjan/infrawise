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

describe("crash recovery (kill -9 semantics)", () => {
  it("restart adopts active sessions into grace; non-returning client expires; successor gets a larger fence", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const sessionId = await requestAndActivate(lab, "victim");
    const oldFence = (await lab.store.getSession(sessionId))!.leaseFence;
    await lab.core.createRequest(token("successor"));

    // kill -9: no shutdown hooks run; new process over the same Redis.
    const lab2 = await lab.restart();

    // reconcile moved the active session into DISCONNECTED with a grace window
    expect((await lab2.store.getSession(sessionId))!.state).toBe(
      "DISCONNECTED",
    );

    // victim never reconnects; grace passes
    lab2.clock.advance(16_000);
    await lab2.core.reaperRunOnce();
    await waitFor(
      async () => (await lab2.store.getSession(sessionId))!.state === "ENDED",
    );

    // cleanup ran, then the queued successor received the device
    expect(
      lab2.adapter.callsOf("cleanup", "fake-1").length,
    ).toBeGreaterThanOrEqual(1);
    await waitFor(
      () =>
        lab2.transport.lastOfType(cid("successor"), "session.reserved") !==
        undefined,
    );
    const r = lab2.transport.lastOfType(cid("successor"), "session.reserved")!;
    const claim = await lab2.core.claimSession(
      token("successor"),
      r.sessionId,
      r.claimToken,
    );
    expect(claim.ok).toBe(true);
    const newFence = (await lab2.store.getSession(r.sessionId))!.leaseFence;
    expect(newFence).toBeGreaterThan(oldFence);
    await lab2.close();
  });

  it("restart preserves the session when the client reconnects within grace", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const sessionId = await requestAndActivate(lab, "survivor");
    const lab2 = await lab.restart();

    lab2.clock.advance(5_000);
    const snapshot = await lab2.core.clientConnected(token("survivor"));
    expect(snapshot.status).toBe("ACTIVE");
    if (snapshot.status === "ACTIVE")
      expect(snapshot.sessionId).toBe(sessionId);
    // the resumed session has a live runtime (input works)
    const fence = (await lab2.store.getSession(sessionId))!.leaseFence;
    lab2.core.handleInput(token("survivor"), {
      type: "input.command",
      sessionId,
      fence,
      seq: 1,
      sentAt: Date.now(),
      payload: { kind: "key", key: "HOME" },
    });
    await waitFor(() => lab2.adapter.callsOf("key").length >= 1);
    await lab2.close();
  });

  it("crash mid-cleanup: restart re-runs idempotent cleanup and frees the device", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const sessionId = await requestAndActivate(lab, "dirty");

    // Freeze cleanup so termination leaves the device CLEANING, then "crash".
    lab.adapter.failOn("cleanup");
    await lab.core.endSession(token("dirty"), sessionId);
    await waitFor(
      async () => (await lab.store.getDevice("fake-1"))!.state === "CLEANING",
    );

    lab.adapter.clearFailure("cleanup");
    const lab2 = await lab.restart();
    await waitFor(
      async () => (await lab2.store.getDevice("fake-1"))!.state === "AVAILABLE",
    );
    expect((await lab2.store.getSession(sessionId))!.state).toBe("ENDED");
    await lab2.close();
  });

  it("cleanup that keeps failing marks the device OFFLINE, and other devices keep serving", async () => {
    const lab = await makeLab(redis.url, { devices: 2 });
    const sessionId = await requestAndActivate(lab, "breaker");
    const deviceId = (await lab.store.getSession(sessionId))!.deviceId;

    lab.adapter.failOn("cleanup");
    await lab.core.endSession(token("breaker"), sessionId);
    await waitFor(
      async () => (await lab.store.getDevice(deviceId))!.state === "OFFLINE",
      8000,
    );
    lab.adapter.clearFailure("cleanup");

    // The healthy device still serves the queue.
    await lab.core.createRequest(token("fresh"));
    await lab.core.pump();
    await waitFor(
      () =>
        lab.transport.lastOfType(cid("fresh"), "session.reserved") !==
        undefined,
    );
    await lab.close();
  });

  it("offline device recovers via health monitor and rejoins the pool", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    lab.adapter.setHealthy("fake-1", false);
    await lab.core.healthRunOnce();
    expect((await lab.store.getDevice("fake-1"))!.state).toBe("OFFLINE");

    lab.adapter.setHealthy("fake-1", true);
    await lab.core.healthRunOnce();
    expect((await lab.store.getDevice("fake-1"))!.state).toBe("AVAILABLE");
    await lab.close();
  });

  it("unhealthy device with an active session ends the session as device_error", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const sessionId = await requestAndActivate(lab, "unlucky");
    lab.adapter.setHealthy("fake-1", false);
    await lab.core.healthRunOnce();
    await waitFor(async () => {
      const s = await lab.store.getSession(sessionId);
      return (
        s!.state === "ENDED" ||
        s!.state === "CLEANING" ||
        s!.state === "EXPIRED"
      );
    });
    expect((await lab.store.getSession(sessionId))!.endReason).toBe(
      "device_error",
    );
    // device must not return to the pool while unhealthy
    await waitFor(
      async () => (await lab.store.getDevice("fake-1"))!.state === "OFFLINE",
      8000,
    );
    await lab.close();
  });
});
