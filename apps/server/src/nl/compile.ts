import {
  LAUNCH_APP_IDS,
  TestStepSchema,
  type CompileResponse,
  type TestStep,
} from "@lab/protocol";

/**
 * LLM-backed natural-language → test-step compiler.
 *
 * Runs only on the server so the OpenAI key never reaches the browser. The
 * model is constrained by a strict JSON schema to a small vocabulary of device
 * actions, and every returned step is re-validated against the shared
 * TestStepSchema before it leaves this module — the LLM cannot emit anything
 * the ordered/fenced input protocol wouldn't already accept. The compiler only
 * produces a plan; execution still goes through the authorized WS input path.
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Direction → normalized swipe geometry (mirrors the client parser).
const SWIPES: Record<string, { from: [number, number]; to: [number, number] }> =
  {
    up: { from: [0.5, 0.72], to: [0.5, 0.28] },
    down: { from: [0.5, 0.28], to: [0.5, 0.72] },
    left: { from: [0.8, 0.5], to: [0.2, 0.5] },
    right: { from: [0.2, 0.5], to: [0.8, 0.5] },
  };

interface LlmStep {
  action: "tap" | "swipe" | "text" | "key" | "launch" | "wait";
  x: number | null;
  y: number | null;
  direction: "up" | "down" | "left" | "right" | null;
  text: string | null;
  key: "back" | "home" | null;
  app: string | null;
  ms: number | null;
  label: string | null;
}

const RESPONSE_SCHEMA = {
  name: "test_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      understood: { type: "boolean" },
      note: { type: "string" },
      steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              enum: ["tap", "swipe", "text", "key", "launch", "wait"],
            },
            x: { type: ["number", "null"] },
            y: { type: ["number", "null"] },
            direction: {
              type: ["string", "null"],
              enum: ["up", "down", "left", "right", null],
            },
            text: { type: ["string", "null"] },
            key: { type: ["string", "null"], enum: ["back", "home", null] },
            app: { type: ["string", "null"], enum: [...LAUNCH_APP_IDS, null] },
            ms: { type: ["number", "null"] },
            label: { type: ["string", "null"] },
          },
          required: [
            "action",
            "x",
            "y",
            "direction",
            "text",
            "key",
            "app",
            "ms",
            "label",
          ],
        },
      },
    },
    required: ["understood", "note", "steps"],
  },
} as const;

function systemPrompt(): string {
  return [
    "You translate a tester's plain-language request into an ordered plan of low-level",
    "actions for a single Android emulator (720x1280, portrait). Return ONLY the plan.",
    "",
    "Coordinates x and y are normalized 0..1 of the visible screen (0,0 = top-left,",
    "1,1 = bottom-right). Prefer swipe `direction` over raw coordinates for scrolling.",
    "For scrolling to reveal content lower on the page, swipe up. Sequence multiple",
    "steps when needed (e.g. open an app, wait, then tap).",
    "",
    "Actions:",
    "- tap: set x,y (center of the target you infer).",
    "- swipe: set direction (up/down/left/right).",
    "- text: set text (printable ASCII; this types into the focused field).",
    "- key: set key (back or home).",
    "- launch: set app to one of the allowed app ids — the reliable way to open an app.",
    `  Allowed app ids: ${LAUNCH_APP_IDS.join(", ")}.`,
    "- wait: set ms (use after launching an app or triggering navigation).",
    "Always include a short human 'label' for each step (max 6 words).",
    "",
    "If the request cannot be expressed with these actions, set understood=false,",
    "return an empty steps array, and explain briefly in note. Never invent actions.",
  ].join("\n");
}

function toTestStep(step: LlmStep): TestStep | null {
  const label = (step.label ?? step.action).slice(0, 80);
  switch (step.action) {
    case "tap": {
      const x = clamp01(step.x ?? 0.5);
      const y = clamp01(step.y ?? 0.5);
      return {
        kind: "input",
        payload: { kind: "tap", point: { x, y } },
        label,
      };
    }
    case "swipe": {
      const geom = SWIPES[step.direction ?? "up"] ?? SWIPES.up!;
      return {
        kind: "input",
        payload: {
          kind: "swipe",
          from: { x: geom.from[0], y: geom.from[1] },
          to: { x: geom.to[0], y: geom.to[1] },
          durationMs: 300,
        },
        label,
      };
    }
    case "text": {
      const text = (step.text ?? "").slice(0, 512);
      if (text.length === 0) return null;
      return { kind: "input", payload: { kind: "text", text }, label };
    }
    case "key": {
      const key = step.key === "home" ? "HOME" : "BACK";
      return { kind: "input", payload: { kind: "key", key }, label };
    }
    case "launch": {
      if (
        !step.app ||
        !(LAUNCH_APP_IDS as readonly string[]).includes(step.app)
      )
        return null;
      return {
        kind: "input",
        payload: {
          kind: "launch",
          app: step.app as (typeof LAUNCH_APP_IDS)[number],
        },
        label,
      };
    }
    case "wait": {
      const ms = Math.min(30_000, Math.max(50, Math.round(step.ms ?? 1000)));
      return { kind: "wait", ms, label };
    }
    default:
      return null;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

export async function compileWithLlm(
  text: string,
  opts: { apiKey: string; model: string; timeoutMs?: number },
): Promise<CompileResponse> {
  if (!opts.apiKey) {
    return {
      ok: false,
      steps: [],
      error: "AI compiler is not configured",
      source: "llm",
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: text.slice(0, 600) },
        ],
        response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        steps: [],
        error: `AI service error (${res.status})`,
        note: detail.slice(0, 200),
        source: "llm",
      };
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content)
      return {
        ok: false,
        steps: [],
        error: "AI returned no plan",
        source: "llm",
      };

    let parsed: { understood?: boolean; note?: string; steps?: LlmStep[] };
    try {
      parsed = JSON.parse(content);
    } catch {
      return {
        ok: false,
        steps: [],
        error: "AI returned malformed plan",
        source: "llm",
      };
    }

    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const steps: TestStep[] = [];
    for (const raw of rawSteps.slice(0, 20)) {
      const mapped = toTestStep(raw);
      if (!mapped) continue;
      const check = TestStepSchema.safeParse(mapped);
      if (check.success) steps.push(check.data);
    }

    if (parsed.understood === false || steps.length === 0) {
      return {
        ok: false,
        steps: [],
        error:
          parsed.note?.slice(0, 200) ||
          "Couldn’t turn that into device actions.",
        source: "llm",
      };
    }
    return { ok: true, steps, note: parsed.note?.slice(0, 200), source: "llm" };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      steps: [],
      error: aborted ? "AI request timed out" : "AI request failed",
      source: "llm",
    };
  } finally {
    clearTimeout(timer);
  }
}
