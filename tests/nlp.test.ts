import { describe, expect, it } from "vitest";
import { parseCommand } from "../apps/web/src/lib/nlp.js";

describe("natural-language test-step parser", () => {
  it("parses simple taps with places", () => {
    const r = parseCommand("tap the center");
    expect(r.ok).toBe(true);
    expect(r.steps[0]).toMatchObject({
      kind: "input",
      payload: { kind: "tap", point: { x: 0.5, y: 0.5 } },
    });
    expect(parseCommand("click top right").steps[0]).toMatchObject({
      payload: { kind: "tap", point: { x: 0.85, y: 0.12 } },
    });
  });

  it("parses coordinate taps in percent and fractions", () => {
    expect(parseCommand("tap at 30% 70%").steps[0]).toMatchObject({
      payload: { kind: "tap", point: { x: 0.3, y: 0.7 } },
    });
    expect(parseCommand("tap 0.25 0.5").steps[0]).toMatchObject({
      payload: { kind: "tap", point: { x: 0.25, y: 0.5 } },
    });
  });

  it("parses swipes and inverts scroll direction", () => {
    const swipe = parseCommand("swipe up").steps[0]!;
    expect(swipe).toMatchObject({ payload: { kind: "swipe" } });
    if (swipe.kind === "input" && swipe.payload.kind === "swipe") {
      expect(swipe.payload.from.y).toBeGreaterThan(swipe.payload.to.y);
    }
    const scroll = parseCommand("scroll down").steps[0]!;
    if (scroll.kind === "input" && scroll.payload.kind === "swipe") {
      // scroll down reveals lower content: finger moves up
      expect(scroll.payload.from.y).toBeGreaterThan(scroll.payload.to.y);
    }
  });

  it("parses text, keys, waits, and system surfaces", () => {
    expect(parseCommand('type "Hello, World!"').steps[0]).toMatchObject({
      payload: { kind: "text", text: "Hello, World!" },
    });
    expect(parseCommand("go back").steps[0]).toMatchObject({
      payload: { kind: "key", key: "BACK" },
    });
    expect(parseCommand("press home").steps[0]).toMatchObject({
      payload: { kind: "key", key: "HOME" },
    });
    expect(parseCommand("wait 2s").steps[0]).toMatchObject({
      kind: "wait",
      ms: 2000,
    });
    expect(parseCommand("wait 500ms").steps[0]).toMatchObject({
      kind: "wait",
      ms: 500,
    });
    expect(parseCommand("open notifications").steps[0]).toMatchObject({
      payload: { kind: "swipe" },
    });
  });

  it("chains clauses with then / semicolons / newlines", () => {
    const r = parseCommand('swipe up, then tap the center, then type "ok"');
    expect(r.ok).toBe(true);
    expect(
      r.steps.map((s) => (s.kind === "input" ? s.payload.kind : "wait")),
    ).toEqual(["swipe", "tap", "text"]);
    const multiline = parseCommand("press home\nopen app drawer\nwait 1s");
    expect(multiline.ok).toBe(true);
    expect(multiline.steps).toHaveLength(3);
  });

  it("expands double tap and long press", () => {
    expect(parseCommand("double tap center").steps).toHaveLength(2);
    const hold = parseCommand("long press the center").steps[0]!;
    if (hold.kind === "input" && hold.payload.kind === "swipe") {
      expect(hold.payload.from).toEqual(hold.payload.to);
      expect(hold.payload.durationMs).toBeGreaterThanOrEqual(500);
    }
  });

  it("rejects nonsense with a helpful error naming the clause", () => {
    const r = parseCommand("swipe up then do a backflip");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("backflip");
    expect(r.steps).toHaveLength(0); // nothing runs when any clause fails
  });
});
