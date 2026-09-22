import { useCallback, useEffect, useRef, useState } from "react";
import { pointerToNormalized, type InputPayload } from "@lab/protocol";
import type { FramePayload, LabConnection } from "../lib/connection.js";

interface Props {
  lab: LabConnection;
  deviceWidth: number;
  deviceHeight: number;
}

interface TouchDot {
  id: number;
  x: number;
  y: number;
}

const TAP_MAX_DISTANCE_PX = 12;
const TAP_MAX_DURATION_MS = 350;

/**
 * Renders the device stream into a canvas that preserves aspect ratio inside
 * its container (letterboxed), and converts pointer gestures into normalized
 * tap/swipe commands. Coordinates use the shared mapping math, so clicks stay
 * accurate at any browser size.
 */
export function DeviceViewport({ lab, deviceWidth, deviceHeight }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const [dots, setDots] = useState<TouchDot[]>([]);
  const dotId = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = deviceWidth;
    canvas.height = deviceHeight;
    const ctx = canvas.getContext("2d");
    lab.onFrame = (frame: FramePayload) => {
      ctx?.drawImage(frame.bitmap, 0, 0, deviceWidth, deviceHeight);
      frame.bitmap.close();
    };
    return () => {
      lab.onFrame = null;
    };
  }, [lab, deviceWidth, deviceHeight]);

  const showDot = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dot: TouchDot = {
      id: dotId.current++,
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
    setDots((d) => [...d, dot]);
    setTimeout(() => setDots((d) => d.filter((x) => x.id !== dot.id)), 500);
  }, []);

  const toNormalized = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return pointerToNormalized(
        clientX - rect.left,
        clientY - rect.top,
        rect.width,
        rect.height,
        deviceWidth,
        deviceHeight,
      );
    },
    [deviceWidth, deviceHeight],
  );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    pointerStart.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const start = pointerStart.current;
      pointerStart.current = null;
      if (!start) return;
      const distance = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      const duration = performance.now() - start.t;

      let payload: InputPayload | null = null;
      if (distance <= TAP_MAX_DISTANCE_PX && duration <= TAP_MAX_DURATION_MS) {
        const point = toNormalized(start.x, start.y);
        if (point) payload = { kind: "tap", point };
      } else {
        // Pointer-move samples collapse into one semantic swipe.
        const from = toNormalized(start.x, start.y);
        const to = toNormalized(e.clientX, e.clientY);
        if (from && to) {
          payload = {
            kind: "swipe",
            from,
            to,
            durationMs: Math.round(Math.min(Math.max(duration, 40), 2000)),
          };
        }
      }
      if (payload) {
        showDot(e.clientX, e.clientY);
        lab.sendInput(payload);
      }
    },
    [lab, toNormalized, showDot],
  );

  return (
    <div
      ref={containerRef}
      className="viewport"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} className="viewport-canvas" />
      {dots.map((dot) => (
        <span
          key={dot.id}
          className="touch-dot"
          style={{ left: dot.x, top: dot.y }}
        />
      ))}
    </div>
  );
}
