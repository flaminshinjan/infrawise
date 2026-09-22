import { useCallback, useEffect, useRef, useState } from "react";
import {
  pointerToNormalized,
  type InputPayload,
  type NormalizedPoint,
} from "@lab/protocol";
import type {
  FramePayload,
  GesturePreview,
  LabConnection,
} from "../lib/connection.js";

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
 * its container (letterboxed), converts pointer gestures into normalized
 * tap/swipe commands (shared mapping math, so clicks are accurate at any
 * size), and drives an animated cursor overlay: when a scripted step runs, the
 * cursor flies to the target and taps/drags so the pointer is visibly acting.
 */
export function DeviceViewport({ lab, deviceWidth, deviceHeight }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const [dots, setDots] = useState<TouchDot[]>([]);
  const [ghostKey, setGhostKey] = useState<{
    id: number;
    label: string;
  } | null>(null);
  const dotId = useRef(0);
  const cursorBusy = useRef(false);

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

  // Map a normalized device point to a pixel offset inside the container,
  // honoring the letterbox so the cursor lands exactly where the tap will.
  const toContainer = useCallback(
    (p: NormalizedPoint): { x: number; y: number } | null => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const scale = Math.min(
        rect.width / deviceWidth,
        rect.height / deviceHeight,
      );
      const rw = deviceWidth * scale;
      const rh = deviceHeight * scale;
      const ox = (rect.width - rw) / 2;
      const oy = (rect.height - rh) / 2;
      return { x: ox + p.x * rw, y: oy + p.y * rh };
    },
    [deviceWidth, deviceHeight],
  );

  const moveCursor = useCallback((x: number, y: number, ms: number) => {
    const el = cursorRef.current;
    if (!el) return;
    el.style.transition = `left ${ms}ms cubic-bezier(0.4,0,0.2,1), top ${ms}ms cubic-bezier(0.4,0,0.2,1)`;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.opacity = "1";
  }, []);

  const setPressed = useCallback((pressed: boolean) => {
    cursorRef.current?.classList.toggle("pressed", pressed);
  }, []);

  // Animate the cursor for a previewed gesture.
  useEffect(() => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const animate = async (g: GesturePreview) => {
      if (cursorBusy.current) return;
      cursorBusy.current = true;
      try {
        if (g.kind === "tap") {
          const c = toContainer(g.point);
          if (!c) return;
          moveCursor(c.x, c.y, 420);
          await sleep(430);
          setPressed(true);
          rippleAt(c.x, c.y);
          await sleep(160);
          setPressed(false);
        } else if (g.kind === "swipe") {
          const from = toContainer(g.from);
          const to = toContainer(g.to);
          if (!from || !to) return;
          moveCursor(from.x, from.y, 320);
          await sleep(330);
          setPressed(true);
          await sleep(60);
          moveCursor(to.x, to.y, g.durationMs);
          await sleep(g.durationMs + 40);
          rippleAt(to.x, to.y);
          setPressed(false);
        } else {
          // text / key / launch — no coordinate; show a labeled pulse
          const label =
            g.kind === "text"
              ? `type “${g.text.slice(0, 18)}${g.text.length > 18 ? "…" : ""}”`
              : g.kind === "key"
                ? g.key === "BACK"
                  ? "◀ Back"
                  : "● Home"
                : `launch ${g.app.replace(/_/g, " ")}`;
          setGhostKey({ id: dotId.current++, label });
          await sleep(900);
          setGhostKey(null);
        }
      } finally {
        cursorBusy.current = false;
      }
    };
    const rippleAt = (x: number, y: number) => {
      const dot: TouchDot = { id: dotId.current++, x, y };
      setDots((d) => [...d, dot]);
      setTimeout(() => setDots((d) => d.filter((v) => v.id !== dot.id)), 600);
    };
    return lab.subscribeGestures((g) => void animate(g));
  }, [lab, toContainer, moveCursor, setPressed]);

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
      <div ref={cursorRef} className="ai-cursor" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26">
          <path
            d="M5 3l14 8-6 1.5L10 20 5 3z"
            fill="currentColor"
            stroke="var(--cursor-stroke)"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      {ghostKey && <div className="ghost-key">{ghostKey.label}</div>}
    </div>
  );
}
