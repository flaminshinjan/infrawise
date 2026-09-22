import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InputCommand, InputPayload } from "@lab/protocol";
import {
  cid,
  makeLab,
  requestAndActivate,
  startRedis,
  token,
  waitFor,
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

function cmd(
  sessionId: string,
  fence: number,
  seq: number,
  payload?: InputPayload,
): InputCommand {
  return {
    type: "input.command",
    sessionId,
    fence,
    seq,
    sentAt: Date.now(),
    payload: payload ?? { kind: "tap", point: { x: 0.5, y: 0.5 } },
  };
}

async function acksFor(lab: TestLab, name: string, count: number) {
  await waitFor(
    () =>
      lab.transport.of(cid(name)).filter((m) => m.type === "input.ack")
        .length >= count,
    5000,
    `${count} acks`,
  );
  return lab.transport
    .of(cid(name))
    .filter(
      (m): m is Extract<typeof m, { type: "input.ack" }> =>
        m.type === "input.ack",
    );
}

describe("ordered input", () => {
  it("executes 1,2 in order, dedupes duplicate 2, rejects 4 with expectedSeq=3", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const sessionId = await requestAndActivate(lab, "user");
    const session = await lab.store.getSession(sessionId);
    const fence = session!.leaseFence;

    lab.core.handleInput(token("user"), cmd(sessionId, fence, 1));
    lab.core.handleInput(token("user"), cmd(sessionId, fence, 2));
    lab.core.handleInput(token("user"), cmd(sessionId, fence, 2)); // duplicate
    lab.core.handleInput(token("user"), cmd(sessionId, fence, 4)); // gap

    const acks = await acksFor(lab, "user", 4);
    const bySeq = new Map(acks.map((a) => [`${a.seq}:${a.status}`, a]));
    expect(bySeq.has("1:applied") || bySeq.has("1:duplicate")).toBe(true);
    expect(
      acks.find((a) => a.seq === 2 && a.status === "duplicate"),
    ).toBeDefined();
    const rejected = acks.find((a) => a.seq === 4);
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.expectedSeq).toBe(3);

    await waitFor(
      () => lab.adapter.callsOf("tap").length === 2,
      3000,
      "exactly two taps",
    );
    // now send 3 then 4: both applied, order preserved
    lab.core.handleInput(token("user"), cmd(sessionId, fence, 3));
    lab.core.handleInput(token("user"), cmd(sessionId, fence, 4));
    await waitFor(
      () => lab.adapter.callsOf("tap").length === 4,
      3000,
      "four taps total",
    );

    // duplicate 2 was never re-executed: exactly 4 taps for seqs 1..4
    expect(lab.adapter.callsOf("tap")).toHaveLength(4);
    const finalSession = await lab.store.getSession(sessionId);
    expect(finalSession?.lastAcceptedInputSeq).toBe(4);
    await lab.close();
  });

  it("stale fence commands are rejected with zero adapter invocations", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const firstSession = await requestAndActivate(lab, "alice");
    const oldFence = (await lab.store.getSession(firstSession))!.leaseFence;

    await lab.core.createRequest(token("bob"));
    await lab.core.endSession(token("alice"), firstSession);
    await waitFor(
      () =>
        lab.transport.lastOfType(cid("bob"), "session.reserved") !== undefined,
    );
    const r = lab.transport.lastOfType(cid("bob"), "session.reserved")!;
    await lab.core.claimSession(token("bob"), r.sessionId, r.claimToken);
    const newFence = (await lab.store.getSession(r.sessionId))!.leaseFence;
    expect(newFence).toBe(oldFence + 1);

    const tapsBefore = lab.adapter.callsOf("tap").length;
    // Delayed command from the dead session carrying the old fence.
    lab.core.handleInput(token("alice"), cmd(firstSession, oldFence, 1));
    const acks = await acksFor(lab, "alice", 1);
    expect(acks[acks.length - 1]?.status).toBe("rejected");
    expect(lab.adapter.callsOf("tap")).toHaveLength(tapsBefore);

    // Even against the *new* session, alice is not the owner.
    lab.core.handleInput(token("alice"), cmd(r.sessionId, newFence, 1));
    const acks2 = await acksFor(lab, "alice", 2);
    expect(acks2[acks2.length - 1]?.status).toBe("rejected");
    expect(lab.adapter.callsOf("tap")).toHaveLength(tapsBefore);
    await lab.close();
  });

  it("text length limits and swipe execution", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const sessionId = await requestAndActivate(lab, "typer");
    const fence = (await lab.store.getSession(sessionId))!.leaseFence;

    lab.core.handleInput(
      token("typer"),
      cmd(sessionId, fence, 1, { kind: "text", text: "x".repeat(600) }),
    );
    const acks = await acksFor(lab, "typer", 1);
    expect(acks[0]?.status).toBe("rejected");

    lab.core.handleInput(
      token("typer"),
      cmd(sessionId, fence, 2, {
        kind: "swipe",
        from: { x: 0.5, y: 0.8 },
        to: { x: 0.5, y: 0.2 },
        durationMs: 300,
      }),
    );
    await waitFor(() => lab.adapter.callsOf("swipe").length === 1);
    const swipe = lab.adapter.callsOf("swipe")[0]!;
    // normalized 0.5 of 720 => 360; 0.8 of 1280 => 1024
    expect(swipe.args[0]).toEqual({ x: 360, y: 1024 });
    await lab.close();
  });

  it("input after session end is rejected", async () => {
    const lab = await makeLab(redis.url, { devices: 1 });
    const sessionId = await requestAndActivate(lab, "ender");
    const fence = (await lab.store.getSession(sessionId))!.leaseFence;
    await lab.core.endSession(token("ender"), sessionId);
    const taps = lab.adapter.callsOf("tap").length;
    lab.core.handleInput(token("ender"), cmd(sessionId, fence, 1));
    const acks = await acksFor(lab, "ender", 1);
    expect(acks[0]?.status).toBe("rejected");
    expect(lab.adapter.callsOf("tap")).toHaveLength(taps);
    await lab.close();
  });
});
