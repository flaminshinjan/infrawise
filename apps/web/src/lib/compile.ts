import type { CompileResponse } from "@lab/protocol";
import { getClientToken } from "./connection.js";

const API_ORIGIN: string =
  (import.meta.env?.VITE_API_ORIGIN as string | undefined) ?? "";

/**
 * Ask the server to compile a natural-language request into test steps with
 * the LLM. Used only as a fallback when the instant local parser can't handle
 * the phrasing. The OpenAI key lives on the server; the browser never sees it.
 */
export async function compileRemote(text: string): Promise<CompileResponse> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/v1/compile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-token": getClientToken(),
      },
      body: JSON.stringify({ text }),
    });
    const body = (await res.json().catch(() => null)) as CompileResponse | null;
    if (!body) {
      return {
        ok: false,
        steps: [],
        error: `AI unavailable (${res.status})`,
        source: "llm",
      };
    }
    return body;
  } catch {
    return {
      ok: false,
      steps: [],
      error: "Could not reach the AI compiler",
      source: "llm",
    };
  }
}
