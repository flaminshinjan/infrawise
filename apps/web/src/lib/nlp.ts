import type { InputPayload, LaunchAppId, NormalizedPoint } from "@lab/protocol";

/**
 * Natural-language → test-step compiler.
 *
 * The chat pane feeds each message through this parser; every step compiles
 * to the same ordered input protocol the pointer uses, so a sentence like
 * "open settings, then type hello, then go back" becomes an exact, replayable
 * command sequence with per-step acknowledgements. It is deterministic (no
 * model in the loop): the same sentence always produces the same steps — the
 * property an agent planner wants from an execution layer — but it is
 * deliberately forgiving about filler, politeness, and phrasing so plain
 * requests just work.
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

/** app synonyms → LaunchAppId. Order doesn't matter; longest match wins. */
const APP_SYNONYMS: Array<[RegExp, LaunchAppId]> = [
  [/\b(wi-?fi|wireless)( settings)?\b/, "wifi_settings"],
  [/\bbluetooth( settings)?\b/, "bluetooth_settings"],
  [/\b(display|brightness|screen) settings\b/, "display_settings"],
  [/\b(app|application)s? settings\b/, "app_settings"],
  [/\b(settings|setting|preferences)\b/, "settings"],
  [/\b(chrome|browser|web browser)\b/, "chrome"],
  [/\bcamera\b/, "camera"],
  [/\b(clock|alarm|alarms|timer)\b/, "clock"],
  [/\b(phone|dialer|dial pad|dialpad|call)\b/, "phone"],
  [/\b(contacts|people)\b/, "contacts"],
  [/\b(messages|messaging|texts|sms)\b/, "messages"],
  [/\b(calculator|calc)\b/, "calculator"],
  [/\b(gmail|email|mail)\b/, "gmail"],
  [/\b(maps|google maps|navigation)\b/, "maps"],
  [/\b(photos|gallery|pictures)\b/, "photos"],
  [/\b(play store|playstore|google play|store)\b/, "play_store"],
  [/\b(files|file manager|file browser)\b/, "files"],
  [/\b(app drawer|apps? list|all apps|app library)\b/, "app_drawer"],
];

const APP_LABELS: Record<LaunchAppId, string> = {
  settings: "open Settings",
  wifi_settings: "open Wi-Fi settings",
  bluetooth_settings: "open Bluetooth settings",
  display_settings: "open Display settings",
  app_settings: "open App settings",
  chrome: "open Chrome",
  camera: "open Camera",
  clock: "open Clock",
  phone: "open Phone",
  contacts: "open Contacts",
  messages: "open Messages",
  calculator: "open Calculator",
  gmail: "open Gmail",
  maps: "open Maps",
  photos: "open Photos",
  play_store: "open Play Store",
  files: "open Files",
  app_drawer: "open app drawer",
};

export const EXAMPLE_COMMANDS = [
  "open settings",
  "go to wifi settings",
  "open the app drawer",
  "swipe up",
  "open camera, then wait 1s, then press back",
  "tap the center",
  'type "hello world"',
  "open chrome",
  "scroll down",
  "go home",
];

export const GRAMMAR_HELP = [
  "open / go to <app> — settings, wifi, chrome, camera, clock, phone,",
  "   contacts, messages, calculator, gmail, maps, photos, play store, files",
  "open the app drawer · open notifications · open quick settings",
  "tap <center | top | bottom | left | right | top left | …>",
  "tap at <x>% <y>%   ·   double tap <place>   ·   long press <place>",
  "swipe <up | down | left | right>   ·   scroll <up | down>",
  'type "some text"   (printable ASCII, sent as one command)',
  "press <back | home> · go back · go home",
  "wait <n>s or <n>ms",
  "Chain steps with “then”, “;”, “and then”, or new lines.",
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

function launchStep(app: LaunchAppId): TestStep {
  return {
    kind: "input",
    payload: { kind: "launch", app },
    label: APP_LABELS[app],
  };
}

/** Strip politeness/filler so plain requests parse. Runs before matching. */
function normalize(clause: string): string {
  let s = clause.toLowerCase().trim();
  s = s.replace(
    /^(?:please|pls|plz|can you|could you|would you|kindly|now|hey|ok|okay)\b[\s,]*/g,
    "",
  );
  s = s.replace(
    /\b(?:please|pls|plz|for me|now|thanks|thank you|thx)\b[\s.!]*$/g,
    "",
  );
  s = s.replace(
    /^(?:i (?:want|need|would like) (?:to|you to)|let'?s|lets|try to|go ahead and|just)\s+/g,
    "",
  );
  s = s
    .replace(/\s+/g, " ")
    .replace(/[.!]+$/g, "")
    .trim();
  return s;
}

function findApp(text: string): LaunchAppId | null {
  for (const [re, id] of APP_SYNONYMS) if (re.test(text)) return id;
  return null;
}

function parsePlace(raw: string): NormalizedPoint | null {
  const cleaned = raw
    .replace(
      /\b(the|a|an|screen|of|on|button|icon|corner|edge|side|part|area)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return PLACES["center"] ?? null;
  if (PLACES[cleaned]) return PLACES[cleaned];
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

/** Parse one normalized clause into steps; null = not understood. */
function parseClause(rawClause: string): TestStep[] | null {
  const raw = rawClause.trim();
  if (raw === "") return [];
  const lower = normalize(raw);
  if (lower === "") return [];

  // waits
  const wait = lower.match(
    /^(?:wait|pause|sleep|hold on|delay)(?:\s+for)?\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|milliseconds?)?/,
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

  // keys — check before generic verbs
  if (
    /^(?:press |tap |hit |go |navigate )?back(?:\s+button)?$/.test(lower) ||
    lower === "go back"
  ) {
    return [
      {
        kind: "input",
        payload: { kind: "key", key: "BACK" },
        label: "press Back",
      },
    ];
  }
  if (
    /^(?:press |tap |hit |go (?:to )?)?home(?:\s+button|\s+screen)?$/.test(
      lower,
    ) ||
    lower === "go home" ||
    lower === "home"
  ) {
    return [
      {
        kind: "input",
        payload: { kind: "key", key: "HOME" },
        label: "press Home",
      },
    ];
  }

  // system surfaces (before app launch so "open notifications" isn't an app)
  if (
    /\bnotifications?\b/.test(lower) &&
    /\b(open|show|pull down|expand|drag down)\b/.test(lower)
  ) {
    return [
      swipeStep(
        { x: 0.5, y: 0.02 },
        { x: 0.5, y: 0.7 },
        250,
        "open notifications",
      ),
    ];
  }
  if (
    /\bquick settings\b/.test(lower) &&
    /\b(open|show|expand)\b/.test(lower)
  ) {
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

  // app launch: "open/go to/launch/start/navigate to/show me <app>"
  const launchVerb = lower.match(
    /^(?:open|launch|start|run|go\s*(?:to|into)?|navigate to|take me to|show(?: me)?|bring up|goto)\b\s*(.*)$/,
  );
  if (launchVerb) {
    const rest = (launchVerb[1] ?? "")
      .replace(/\b(the|my|a|an|app|application|screen|page|menu)\b/g, " ")
      .trim();
    const app = findApp(rest) ?? findApp(lower);
    if (app) return [launchStep(app)];
    // "open notifications"/"app drawer" handled above; anything else unknown
  }
  // bare app name anywhere with an app synonym and no other verb, e.g. "settings"
  if (/^[\w\s-]+$/.test(lower) && lower.split(" ").length <= 3) {
    const app = findApp(lower);
    if (app) return [launchStep(app)];
  }

  // typing — quoted text keeps exact content; unquoted takes the rest
  const typed =
    raw.match(/^(?:type|enter|input|write|send)\s+"(.+)"$/is) ??
    raw.match(/^(?:type|enter|input|write|send)\s+'(.+)'$/is) ??
    raw.match(/^(?:type|enter|input|write|send)\s+(.+)$/is);
  if (typed && typed[1] !== undefined) {
    const text = typed[1].trim().replace(/\s+(?:please|pls|now)$/i, "");
    if (text.length === 0 || text.length > 512) return null;
    return [
      {
        kind: "input",
        payload: { kind: "text", text },
        label: `type “${text}”`,
      },
    ];
  }

  // swipe / scroll / drag / flick — direction can appear anywhere in the clause
  if (/\b(swipe|scroll|drag|flick|fling)\b/.test(lower)) {
    const dirMatch = lower.match(/\b(up|down|left|right)\b/);
    if (dirMatch) {
      const verb = lower.match(/\b(swipe|scroll|drag|flick|fling)\b/)![1]!;
      const spoken = dirMatch[1] as "up" | "down" | "left" | "right";
      // "scroll down" reveals lower content → finger moves up (invert)
      const direction =
        verb === "scroll"
          ? ({ up: "down", down: "up", left: "right", right: "left" } as const)[
              spoken
            ]
          : spoken;
      const geom = SWIPES[direction]!;
      return [swipeStep(geom.from, geom.to, 300, `${verb} ${spoken}`)];
    }
  }

  // long press / hold
  const longPress = lower.match(
    /^(?:long[\s-]*press|press and hold|hold(?:\s+down)?|tap and hold)\b(.*)$/,
  );
  if (longPress) {
    const place = parsePlace(longPress[1] ?? "");
    if (place) return [swipeStep(place, place, 650, "long press")];
    return null;
  }

  // double tap
  const doubleTap = lower.match(/^double[\s-]*(?:tap|click|press)\b(.*)$/);
  if (doubleTap) {
    const place = parsePlace(doubleTap[1] ?? "");
    if (place)
      return [point(place, "twice (1/2)"), point(place, "twice (2/2)")];
    return null;
  }

  // tap / click / touch / press <place>
  const tap = lower.match(
    /^(?:tap|click|touch|press|hit|select|choose)\b(.*)$/,
  );
  if (tap) {
    const place = parsePlace((tap[1] ?? "").trim());
    if (place) {
      const label = (tap[1] ?? "").trim() || "center";
      return [point(place, label)];
    }
    return null;
  }

  return null;
}

export function parseCommand(text: string): ParseResult {
  const clauses = text
    .split(/\s*(?:\bthen\b|\band then\b|;|\n|→|->)\s*/i)
    .map((c) =>
      c
        .replace(/^(?:,|\.|and|then)\s+/i, "")
        .replace(/[,]\s*$/, "")
        .trim(),
    )
    .filter((c) => c.length > 0);
  if (clauses.length === 0)
    return { ok: false, steps: [], error: "Empty command." };

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
