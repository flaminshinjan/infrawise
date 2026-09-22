import { describe, expect, it } from "vitest";
import { normalizedToDevice, pointerToNormalized } from "@lab/protocol";

const DEV_W = 720;
const DEV_H = 1280;

describe("pointerToNormalized", () => {
  it("same aspect ratio: no letterbox, corners map to 0..1", () => {
    // container 360x640 = same 9:16 aspect
    expect(pointerToNormalized(0, 0, 360, 640, DEV_W, DEV_H)).toEqual({
      x: 0,
      y: 0,
    });
    expect(pointerToNormalized(360, 640, 360, 640, DEV_W, DEV_H)).toEqual({
      x: 1,
      y: 1,
    });
    expect(pointerToNormalized(180, 320, 360, 640, DEV_W, DEV_H)).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });

  it("horizontal letterboxing: wide container centers content", () => {
    // container 1000x640 -> scale = 0.5, rendered 360x640, offsetX = 320
    const center = pointerToNormalized(500, 320, 1000, 640, DEV_W, DEV_H);
    expect(center).toEqual({ x: 0.5, y: 0.5 });
    const leftEdge = pointerToNormalized(320, 320, 1000, 640, DEV_W, DEV_H);
    expect(leftEdge).toEqual({ x: 0, y: 0.5 });
    // inside the letterbox bar -> rejected (content spans x = 320..680)
    expect(pointerToNormalized(100, 320, 1000, 640, DEV_W, DEV_H)).toBeNull();
    expect(pointerToNormalized(690, 320, 1000, 640, DEV_W, DEV_H)).toBeNull();
    expect(pointerToNormalized(650, 320, 1000, 640, DEV_W, DEV_H)).toEqual({
      x: (650 - 320) / 360,
      y: 0.5,
    });
  });

  it("vertical letterboxing: tall container centers content", () => {
    // container 360x1000 -> scale 0.5, rendered 360x640, offsetY = 180
    expect(pointerToNormalized(180, 500, 360, 1000, DEV_W, DEV_H)).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(pointerToNormalized(180, 180, 360, 1000, DEV_W, DEV_H)).toEqual({
      x: 0.5,
      y: 0,
    });
    expect(pointerToNormalized(180, 100, 360, 1000, DEV_W, DEV_H)).toBeNull();
    expect(pointerToNormalized(180, 900, 360, 1000, DEV_W, DEV_H)).toBeNull();
  });

  it("resized window keeps mapping accurate", () => {
    // any container: the same relative point returns the same normalized value
    for (const [cw, ch] of [
      [200, 900],
      [1440, 900],
      [333, 517],
    ] as const) {
      const scale = Math.min(cw / DEV_W, ch / DEV_H);
      const rw = DEV_W * scale;
      const rh = DEV_H * scale;
      const ox = (cw - rw) / 2;
      const oy = (ch - rh) / 2;
      const p = pointerToNormalized(
        ox + rw * 0.25,
        oy + rh * 0.75,
        cw,
        ch,
        DEV_W,
        DEV_H,
      );
      expect(p!.x).toBeCloseTo(0.25, 10);
      expect(p!.y).toBeCloseTo(0.75, 10);
    }
  });

  it("outside-content clicks are rejected", () => {
    expect(pointerToNormalized(-5, 100, 360, 640, DEV_W, DEV_H)).toBeNull();
    expect(pointerToNormalized(100, 641, 360, 640, DEV_W, DEV_H)).toBeNull();
  });

  it("boundary coordinates are inclusive", () => {
    const topLeft = pointerToNormalized(0, 0, 360, 640, DEV_W, DEV_H);
    const bottomRight = pointerToNormalized(360, 640, 360, 640, DEV_W, DEV_H);
    expect(topLeft).toEqual({ x: 0, y: 0 });
    expect(bottomRight).toEqual({ x: 1, y: 1 });
  });

  it("degenerate containers return null", () => {
    expect(pointerToNormalized(0, 0, 0, 0, DEV_W, DEV_H)).toBeNull();
  });
});

describe("normalizedToDevice", () => {
  it("maps normalized to integer device pixels within bounds", () => {
    expect(normalizedToDevice({ x: 0.5, y: 0.5 }, DEV_W, DEV_H)).toEqual({
      x: 360,
      y: 640,
    });
    expect(normalizedToDevice({ x: 0, y: 0 }, DEV_W, DEV_H)).toEqual({
      x: 0,
      y: 0,
    });
    // 1.0 clamps to the last pixel, never out of bounds
    expect(normalizedToDevice({ x: 1, y: 1 }, DEV_W, DEV_H)).toEqual({
      x: 719,
      y: 1279,
    });
  });

  it("locked-portrait rotation 0 is the identity mapping (declared limitation)", () => {
    const p = normalizedToDevice({ x: 0.25, y: 0.75 }, DEV_W, DEV_H, 0);
    expect(p).toEqual({ x: 180, y: 960 });
  });

  it("rotation 90/180/270 transforms are consistent", () => {
    expect(normalizedToDevice({ x: 1, y: 0 }, DEV_W, DEV_H, 180)).toEqual({
      x: 0,
      y: 1279,
    });
    const r90 = normalizedToDevice({ x: 0, y: 0 }, DEV_W, DEV_H, 90);
    expect(r90).toEqual({ x: 0, y: 1279 });
    const r270 = normalizedToDevice({ x: 0, y: 0 }, DEV_W, DEV_H, 270);
    expect(r270).toEqual({ x: 719, y: 0 });
  });
});
