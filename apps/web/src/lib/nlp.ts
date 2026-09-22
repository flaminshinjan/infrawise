import type { InputPayload, NormalizedPoint } from "@lab/protocol";

/**
 * Deterministic natural-language → test-step compiler.
 *
 * The chat pane feeds each message through this parser; every step compiles
 * to the same ordered input protocol the pointer uses, so a sentence like
 * "open notifications, then type hello, then press back" becomes an exact,
 * replayable command sequence with per-step acknowledgements. The parser is
 * intentionally deterministic (no model in the loop): the same sentence
 * always produces the same steps — which is exactly the property an agent
 * planner would want from this layer.
 */

export type TestStep =
  | { kind: "input"; payload: InputPayload; label: string }
  | { kind: "wait"; ms: number; label: string };

export interface ParseResult {
  ok: boolean;
  steps: TestStep[];
  error?: string;
}

const PLACES: Record<string, NormalizedPoint> = {
  center: { x: 0.5, y: 0.5 },
  middle: { x: 0.5, y: 0.5 },
  "top left": { x: 0.15, y: 0.12 },
  "top right": { x: 0.85, y: 0.12 },
  "bottom left": { x: 0.15, y: 0.9 },
  "bottom right": { x: 0.85, y: 0.9 },
  top: { x: 0.5, y: 0.12 },
  bottom: { x: 0.5, y: 0.9 },
  left: { x: 0.12, y: 0.5 },
  right: { x: 0.88, y: 0.5 },
};

const SWIPES: Record<string, { from: NormalizedPoint; to: NormalizedPoint }> = {
  up: { from: { x: 0.5, y: 0.72 }, to: { x: 0.5, y: 0.28 } },
  down: { from: { x: 0.5, y: 0.28 }, to: { x: 0.5, y: 0.72 } },
  left: { from: { x: 0.8, y: 0.5 }, to: { x: 0.2, y: 0.5 } },
  right: { from: { x: 0.2, y: 0.5 }, to: { x: 0.8, y: 0.5 } },
};

export const EXAMPLE_COMMANDS = [
  "swipe up",
  "tap the center",
  'type "hello world"',
  "open notifications",
  "press home",
  "swipe left, then tap top right",
  "open app drawer, then wait 1s, then type settings",
  "long press the center",
  "tap at 50% 80%",
  "go back",
];

export const GRAMMAR_HELP = [
  "tap <center | top | bottom | left | right | top left | …>",
  "tap at <x>% <y>%   (e.g. tap at 30% 70%)",
  "double tap <place> · long press <place>",
  "swipe <up | down | left | right>  ·  scroll <up | down>",
  "open notifications · open app drawer · open quick settings",
  'type "some text"  (printable ASCII, one ordered command)',
  "press <back | home> · go back · go home",
  "wait <n>s or <n>ms",
  "Chain steps with “then”, “;” or new lines.",
];

function point(p: NormalizedPoint, label: string): TestStep {
  return {
    kind: "input",
    payload: { kind: "tap", point: p },
    label: `tap ${label}`,
  };
}

function swipeStep(
  from: NormalizedPoint,
  to: NormalizedPoint,
  durationMs: number,
  label: string,
): TestStep {
  return {
    kind: "input",
    payload: { kind: "swipe", from, to, durationMs },
    label,
  };
}

function parsePlace(raw: string): NormalizedPoint | null {
  const cleaned = raw
    .replace(/\b(the|screen|of|on|corner|edge|side)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return PLACES["center"] ?? null;
  if (PLACES[cleaned]) return PLACES[cleaned];
  // "at 30% 70%" / "at 0.3 0.7" / "30% 70%"
  const at = cleaned.match(
    /^(?:at\s+)?(\d+(?:\.\d+)?)\s*%?\s*[, ]\s*(\d+(?:\.\d+)?)\s*%?$/,
  );
  if (at) {
    let x = Number(at[1]);
    let y = Number(at[2]);
    if (x > 1) x /= 100;
    if (y > 1) y /= 100;
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) return { x, y };
  }
  return null;
}

/** Parse one clause into one or more steps; returns null when not understood. */
function parseClause(clause: string): TestStep[] | null {
  const raw = clause.trim();
  if (raw === "") return [];
  const lower = raw.toLowerCase();

  // waits
  const wait = lower.match(
    /^(?:wait|pause|sleep)(?:\s+for)?\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|milliseconds?)?$/,
  );
  if (wait) {
    const n = Number(wait[1]);
    const unit = wait[2] ?? "s";
    const ms = unit.startsWith("ms") || unit.startsWith("milli") ? n : n * 1000;
    const bounded = Math.min(Math.max(Math.round(ms), 50), 30_000);
    return [
      {
        kind: "wait",
        ms: bounded,
        label: `wait ${bounded >= 1000 ? bounded / 1000 + "s" : bounded + "ms"}`,
      },
    ];
  }

  // keys
  if (
    /^(?:press\s+|go\s+|hit\s+|navigate\s+)?back(?:\s+button)?$/.test(lower)
  ) {
    return [
      {
        kind: "input",
        payload: { kind: "key", key: "BACK" },
        label: "press Back",
      },
    ];
  }
  if (/^(?:press\s+|go\s+|hit\s+)?home(?:\s+button|\s+screen)?$/.test(lower)) {
    return [
      {
        kind: "input",
        payload: { kind: "key", key: "HOME" },
        label: "press Home",
      },
    ];
  }

  // system surfaces
  if (/^open\s+(?:the\s+)?notification(?:s|\s+shade|\s+panel)?$/.test(lower)) {
    return [
      swipeStep(
        { x: 0.5, y: 0.02 },
        { x: 0.5, y: 0.7 },
        250,
        "open notifications",
      ),
    ];
  }
  if (/^open\s+(?:the\s+)?quick\s*settings$/.test(lower)) {
    return [
      swipeStep({ x: 0.5, y: 0.02 }, { x: 0.5, y: 0.7 }, 250, "open shade"),
      swipeStep(
        { x: 0.5, y: 0.15 },
        { x: 0.5, y: 0.75 },
        250,
        "expand quick settings",
      ),
    ];
  }
  if (/^open\s+(?:the\s+)?app\s*(?:drawer|list|library)$/.test(lower)) {
    return [
      swipeStep(
        { x: 0.5, y: 0.85 },
        { x: 0.5, y: 0.25 },
        250,
        "open app drawer",
      ),
    ];
  }
  if (
    /^(?:close|dismiss)\s+(?:the\s+)?(?:notifications?|shade|drawer|keyboard|dialog)$/.test(
      lower,
    )
  ) {
    return [
      {
        kind: "input",
        payload: { kind: "key", key: "BACK" },
        label: "press Back",
      },
    ];
  }

  // typing — quoted text keeps its exact case/content
  const typed =
    raw.match(/^(?:type|enter|input|write)\s+"(.+)"$/is) ??
    raw.match(/^(?:type|enter|input|write)\s+'(.+)'$/is) ??
    raw.match(/^(?:type|enter|input|write)\s+(.+)$/is);
  if (typed && typed[1] !== undefined) {
    const text = typed[1];
    if (text.length === 0 || text.length > 512) return null;
    return [
      {
        kind: "input",
        payload: { kind: "text", text },
        label: `type “${text}”`,
      },
    ];
  }

  // swipe / scroll / drag
  const swipe = lower.match(
    /^(swipe|scroll|drag|flick)\s+(?:to\s+(?:the\s+)?)?(up|down|left|right)(?:wards?)?$/,
  );
  if (swipe && swipe[2]) {
    const verb = swipe[1]!;
    // "scroll down" means reveal lower content = finger moves up
    const direction =
      verb === "scroll"
        ? ({ up: "down", down: "up", left: "right", right: "left" } as const)[
            swipe[2] as "up" | "down" | "left" | "right"
          ]
        : (swipe[2] as "up" | "down" | "left" | "right");
    const geometry = SWIPES[direction]!;
    return [swipeStep(geometry.from, geometry.to, 300, `${verb} ${swipe[2]}`)];
  }

  // long press
  const longPress = lower.match(
    /^(?:long\s*press|hold|press\s+and\s+hold)(?:\s+(?:on\s+)?(.*))?$/,
  );
  if (longPress) {
    const place = parsePlace(longPress[1] ?? "");
    if (place) {
      return [swipeStep(place, place, 650, `long press`)];
    }
    return null;
  }

  // double tap
  const doubleTap = lower.match(
    /^double\s*(?:tap|click)(?:\s+(?:on\s+)?(.*))?$/,
  );
  if (doubleTap) {
    const place = parsePlace(doubleTap[1] ?? "");
    if (place)
      return [point(place, "twice (1/2)"), point(place, "twice (2/2)")];
    return null;
  }

  // tap / click
  const tap = lower.match(/^(?:tap|click|touch|press)(?:\s+(?:on\s+)?(.*))?$/);
  if (tap) {
    const place = parsePlace(tap[1] ?? "");
    if (place) {
      const label =
        (tap[1] ?? "center").replace(/^at\s+/, "at ").trim() || "center";
      return [point(place, label)];
    }
    return null;
  }

  return null;
}

export function parseCommand(text: string): ParseResult {
  const clauses = text
    .split(/\s*(?:\bthen\b|;|\n)\s*/i)
    .map((c) =>
      c
        .replace(/^(?:,|and|\.)\s*/i, "")
        .replace(/[,.]\s*$/, "")
        .trim(),
    )
    .filter((c) => c.length > 0);
  if (clauses.length === 0) {
    return { ok: false, steps: [], error: "Empty command." };
  }
  const steps: TestStep[] = [];
  for (const clause of clauses) {
    const parsed = parseClause(clause);
    if (parsed === null) {
      return {
        ok: false,
        steps: [],
        error: `Didn’t understand “${clause}”.`,
      };
    }
    steps.push(...parsed);
  }
  if (steps.length === 0)
    return { ok: false, steps: [], error: "Empty command." };
  return { ok: true, steps };
}
