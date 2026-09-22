import { useCallback, useEffect, useRef, useState } from "react";
import type { LabConnection } from "../lib/connection.js";
import { compileRemote } from "../lib/compile.js";
import {
  EXAMPLE_COMMANDS,
  GRAMMAR_HELP,
  parseCommand,
  type TestStep,
} from "../lib/nlp.js";

type StepStatus = "pending" | "running" | "applied" | "rejected" | "skipped";

interface StepEntry {
  label: string;
  status: StepStatus;
  detail?: string;
  tookMs?: number;
}

interface ChatMessage {
  id: number;
  role: "user" | "system";
  text?: string;
  steps?: StepEntry[];
  note?: string;
  thinking?: boolean;
}

interface Props {
  lab: LabConnection;
  sessionKey: string;
}

let nextId = 1;

/**
 * Natural-language test console. Each message compiles to ordered input
 * commands (see lib/nlp.ts); steps run sequentially and display the device's
 * acknowledgement — applied, rejected (with reason), or skipped.
 */
export function ChatPane({ lab, sessionKey }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [chipsVisible, setChipsVisible] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // fresh transcript per session
  useEffect(() => {
    setMessages([
      {
        id: nextId++,
        role: "system",
        text: "Describe test steps in plain language — I’ll run them on the device in order and report each acknowledgement. Try an example below, or type “help”.",
      },
    ]);
  }, [sessionKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const patchMessage = useCallback(
    (id: number, fn: (m: ChatMessage) => ChatMessage) => {
      setMessages((all) => all.map((m) => (m.id === id ? fn(m) : m)));
    },
    [],
  );

  const runSteps = useCallback(
    async (messageId: number, steps: TestStep[]) => {
      setRunning(true);
      try {
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i]!;
          patchMessage(messageId, (m) => ({
            ...m,
            steps: m.steps!.map((s, j) =>
              j === i ? { ...s, status: "running" } : s,
            ),
          }));
          let entry: StepEntry;
          if (step.kind === "wait") {
            await new Promise((r) => setTimeout(r, step.ms));
            entry = { label: step.label, status: "applied" };
          } else {
            const startedAt = performance.now();
            const ack = await lab.sendInputAwaited(step.payload);
            entry =
              ack.status === "rejected"
                ? { label: step.label, status: "rejected", detail: ack.reason }
                : {
                    label: step.label,
                    status: "applied",
                    tookMs: Math.round(performance.now() - startedAt),
                  };
          }
          const failed = entry.status === "rejected";
          patchMessage(messageId, (m) => ({
            ...m,
            steps: m.steps!.map((s, j) =>
              j === i
                ? entry
                : j > i && failed
                  ? { ...s, status: "skipped" }
                  : s,
            ),
          }));
          if (failed) break;
        }
      } finally {
        setRunning(false);
        inputRef.current?.focus();
      }
    },
    [lab, patchMessage],
  );

  const runPlan = useCallback(
    (steps: TestStep[], note?: string) => {
      const id = nextId++;
      setMessages((all) => [
        ...all,
        {
          id,
          role: "system",
          note,
          steps: steps.map((s) => ({
            label: s.label,
            status: "pending" as const,
          })),
        },
      ]);
      void runSteps(id, steps);
    },
    [runSteps],
  );

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "" || running) return;
      setInput("");
      setChipsVisible(false);
      setMessages((all) => [
        ...all,
        { id: nextId++, role: "user", text: trimmed },
      ]);

      if (/^help$/i.test(trimmed)) {
        setMessages((all) => [
          ...all,
          { id: nextId++, role: "system", text: GRAMMAR_HELP.join("\n") },
        ]);
        return;
      }

      // Fast path: the deterministic parser handles common commands instantly.
      const parsed = parseCommand(trimmed);
      if (parsed.ok) {
        runPlan(parsed.steps);
        return;
      }

      // Fallback: let the server-side LLM interpret free-form phrasing.
      const thinkingId = nextId++;
      setMessages((all) => [
        ...all,
        { id: thinkingId, role: "system", thinking: true, text: "Thinking…" },
      ]);
      setRunning(true);
      void (async () => {
        const result = await compileRemote(trimmed);
        setMessages((all) => all.filter((m) => m.id !== thinkingId));
        setRunning(false);
        if (result.ok && result.steps.length > 0) {
          runPlan(
            result.steps,
            result.note ? `AI · ${result.note}` : "interpreted by AI",
          );
        } else {
          const reason =
            result.error ?? parsed.error ?? "Didn’t understand that.";
          setMessages((all) => [
            ...all,
            {
              id: nextId++,
              role: "system",
              text: `${reason} Type “help” for the built-in grammar, or rephrase.`,
            },
          ]);
        }
      })();
    },
    [running, runPlan],
  );

  return (
    <aside className="chat-pane">
      <div className="chat-head">
        <span className="chat-title">Test console</span>
        <span className="chat-sub">
          natural language → ordered device input
        </span>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {m.thinking ? (
              <div className="chat-bubble thinking">
                <span className="step-spinner" /> Thinking…
              </div>
            ) : (
              m.text && <div className="chat-bubble">{m.text}</div>
            )}
            {m.note && <div className="chat-note">{m.note}</div>}
            {m.steps && (
              <div className="chat-steps">
                {m.steps.map((s, i) => (
                  <div key={i} className={`chat-step ${s.status}`}>
                    <span className="step-icon">
                      {s.status === "applied" && "✓"}
                      {s.status === "rejected" && "✕"}
                      {s.status === "running" && (
                        <span className="step-spinner" />
                      )}
                      {s.status === "pending" && "·"}
                      {s.status === "skipped" && "–"}
                    </span>
                    <span className="step-label">{s.label}</span>
                    <span className="step-detail">
                      {s.status === "applied" &&
                        s.tookMs !== undefined &&
                        `${s.tookMs} ms`}
                      {s.status === "rejected" && (s.detail ?? "rejected")}
                      {s.status === "skipped" && "skipped"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {chipsVisible && (
        <div className="chip-float">
          {EXAMPLE_COMMANDS.slice(0, 6).map((example) => (
            <button
              key={example}
              className="chip"
              onClick={() => submit(example)}
            >
              {example}
            </button>
          ))}
        </div>
      )}

      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <button
          type="button"
          className={`chip-toggle ${chipsVisible ? "on" : ""}`}
          title="Example commands"
          onClick={() => setChipsVisible((v) => !v)}
        >
          ✦
        </button>
        <input
          ref={inputRef}
          type="text"
          value={input}
          disabled={running}
          maxLength={600}
          placeholder={
            running ? "Running steps…" : "e.g. swipe up, then tap the center"
          }
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          type="submit"
          className="chat-send"
          disabled={running || input.trim() === ""}
        >
          Run
        </button>
      </form>
    </aside>
  );
}
