import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  cid,
  makeLab,
  startRedis,
  token,
  type TestLab,
  type TestRedis,
} from "./helpers.js";

let redis: TestRedis;

beforeAll(async () => {
  redis = await startRedis();
});

afterAll(async () => {
  await redis.stop();
});

describe("atomic allocation", () => {
  it("one device, many concurrent waiters and allocators: exactly one owner", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const names = Array.from({ length: 10 }, (_, i) => `c${i}`);

    // Concurrent enqueue (clock is manual so scores tie; requestId breaks ties
    // deterministically inside Redis).
    await Promise.all(names.map((n) => lab.core.createRequest(token(n))));

    // Hammer the allocator concurrently, bypassing pump's coalescing, to prove
    // the Lua transaction itself prevents double assignment.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        lab.store.allocate({
          now: lab.clock.now(),
          sessionId: `ses_race_${i}`,
          claimTokenHash: createHash("sha256").update(`t${i}`).digest("hex"),
          claimMs: 10_000,
          sessionMaxMs: 600_000,
          leaseTtlMs: 15_000,
        }),
      ),
    );

    // Exactly one nonterminal session exists and owns the single device.
    const sessionIds = await lab.store.listNonterminalSessionIds();
    expect(sessionIds).toHaveLength(1);
    const session = await lab.store.getSession(sessionIds[0]!);
    const device = await lab.store.getDevice("fake-1");
    expect(device?.state).toBe("RESERVED");
    expect(device?.currentSessionId).toBe(session?.id);

    // Every other request is still queued, in order.
    const order = await lab.store.queueOrder();
    expect(order).toHaveLength(9);
    const positions = await Promise.all(
      order.map((rid) => lab.store.getQueueEntry(rid)),
    );
    for (const entry of positions) expect(entry?.state).toBe("WAITING");

    await lab.close();
  });

  it("duplicate request from the same client returns the existing state", async () => {
    const lab = await makeLab(redis.url, { devices: 0 });
    const first = await lab.core.createRequest(token("dup"));
    const second = await lab.core.createRequest(token("dup"));
    expect(first.status).toBe("WAITING");
    expect(second.status).toBe("WAITING");
    if (first.status === "WAITING" && second.status === "WAITING") {
      expect(second.requestId).toBe(first.requestId);
    }
    expect(await lab.store.queueDepth()).toBe(1);
    await lab.close();
  });

  it("allocation is work-conserving: free device + waiter => immediate reservation", async () => {
    const lab = await makeLab(redis.url, { devices: 2 });
    await lab.core.createRequest(token("w1"));
    await lab.core.pump();
    expect(
      lab.transport.lastOfType(cid("w1"), "session.reserved"),
    ).toBeDefined();
    const device1 = await lab.store.getDevice("fake-1");
    const device2 = await lab.store.getDevice("fake-2");
    const states = [device1?.state, device2?.state].sort();
    expect(states).toEqual(["AVAILABLE", "RESERVED"]);
    await lab.close();
  });

  it("unclaimed reservation expires, device is cleaned and reallocated", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    await lab.core.createRequest(token("ghost"));
    await lab.core.pump();
    const reserved = lab.transport.lastOfType(cid("ghost"), "session.reserved");
    expect(reserved).toBeDefined();

    await lab.core.createRequest(token("patient"));
    lab.clock.advance(11_000); // past RESERVATION_CLAIM_MS
    await lab.core.reaperRunOnce();
    // cleanup runs async; wait for the follow-up allocation
    const { waitFor } = await import("./helpers.js");
    await waitFor(async () => {
      return (
        lab.transport.lastOfType(cid("patient"), "session.reserved") !==
        undefined
      );
    });

    const session = await lab.store.getSession(reserved!.sessionId);
    expect(session?.state).toBe("ENDED");
    expect(session?.endReason).toBe("claim_timeout");
    // ghost's claim with the original token must now fail
    const claim = await lab.core.claimSession(
      token("ghost"),
      reserved!.sessionId,
      reserved!.claimToken,
    );
    expect(claim.ok).toBe(false);
    await lab.close();
  });
});
