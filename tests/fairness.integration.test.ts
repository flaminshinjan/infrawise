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

describe("FIFO fairness", () => {
  it("serves A, B, C in enqueue order as devices release", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const owner = await requestAndActivate(lab, "owner");

    // Deterministic distinct enqueue times.
    await lab.core.createRequest(token("A"));
    lab.clock.advance(10);
    await lab.core.createRequest(token("B"));
    lab.clock.advance(10);
    await lab.core.createRequest(token("C"));

    const served: string[] = [];
    const watch = async (name: string) => {
      await waitFor(
        () =>
          lab.transport.lastOfType(cid(name), "session.reserved") !== undefined,
        5000,
        name,
      );
      served.push(name);
      const r = lab.transport.lastOfType(cid(name), "session.reserved")!;
      await lab.core.claimSession(token(name), r.sessionId, r.claimToken);
      return r.sessionId;
    };

    await lab.core.endSession(token("owner"), owner);
    const sA = await watch("A");
    await lab.core.endSession(token("A"), sA);
    const sB = await watch("B");
    await lab.core.endSession(token("B"), sB);
    await watch("C");

    expect(served).toEqual(["A", "B", "C"]);
    await lab.close();
  });

  it("no starvation under churn: older waiters are never bypassed", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const owner = await requestAndActivate(lab, "own");
    await lab.core.createRequest(token("old-1"));
    lab.clock.advance(5);
    await lab.core.createRequest(token("old-2"));

    // churn: new arrivals keep joining while sessions release
    let sessionId = owner;
    let currentOwner = "own";
    const serveNext = async (expected: string) => {
      lab.clock.advance(5);
      await lab.core.createRequest(token(`churn-${expected}`));
      await lab.core.endSession(token(currentOwner), sessionId);
      await waitFor(
        () =>
          lab.transport.lastOfType(cid(expected), "session.reserved") !==
          undefined,
        5000,
        `reservation for ${expected}`,
      );
      const r = lab.transport.lastOfType(cid(expected), "session.reserved")!;
      const claim = await lab.core.claimSession(
        token(expected),
        r.sessionId,
        r.claimToken,
      );
      expect(claim.ok).toBe(true);
      sessionId = r.sessionId;
      currentOwner = expected;
    };

    await serveNext("old-1");
    await serveNext("old-2");
    // the churn arrivals are served in their own arrival order afterwards
    await serveNext("churn-old-1");
    await lab.close();
  });

  it("cancelled head never blocks allocation", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const owner = await requestAndActivate(lab, "hold");
    const head = await lab.core.createRequest(token("quitter"));
    lab.clock.advance(5);
    await lab.core.createRequest(token("second"));

    expect(head.status).toBe("WAITING");
    if (head.status === "WAITING") {
      await lab.core.cancelRequest(token("quitter"), head.requestId);
    }
    await lab.core.endSession(token("hold"), owner);
    await waitFor(
      () =>
        lab.transport.lastOfType(cid("second"), "session.reserved") !==
        undefined,
    );
    expect(
      lab.transport.lastOfType(cid("quitter"), "session.reserved"),
    ).toBeUndefined();
    await lab.close();
  });

  it("queue positions update over the transport as the queue moves", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    await requestAndActivate(lab, "p0");
    await lab.core.createRequest(token("p1"));
    lab.clock.advance(5);
    await lab.core.createRequest(token("p2"));
    await lab.core.broadcastQueueAndPool();
    expect(lab.transport.lastOfType(cid("p2"), "queue.state")?.position).toBe(
      2,
    );

    const first = lab.transport.lastOfType(cid("p1"), "queue.state");
    expect(first?.position).toBe(1);

    // p1 cancels; p2 must be promoted to position 1
    const p1State = await lab.core.getState(token("p1"));
    if (p1State.status === "WAITING") {
      await lab.core.cancelRequest(token("p1"), p1State.requestId);
    }
    await waitFor(
      () => lab.transport.lastOfType(cid("p2"), "queue.state")?.position === 1,
    );
    await lab.close();
  });
});
