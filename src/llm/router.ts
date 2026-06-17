/**
 * Router seam (§11, mission verbatim). The agent pipeline only ever calls
 * `getRouter()` — it never imports FreeLLMAPI or fetches upstream directly.
 *
 * - mockRouter: built-in heuristic farmer, $0, deterministic (src/llm/mock.ts)
 * - liveRouter: POST /api/agent/complete -> Express proxy -> FreeLLMAPI.
 *   Keys live ONLY in server/.env; this file never sees them.
 *
 * liveRouter NEVER throws: any non-200 or network failure resolves to an
 * LlmResponse with `error` set so the AgentManager can fall back gracefully.
 */
import type { LlmResponse, Router } from "@contracts/types";
import { mockRouter } from "./mock";
import { parseAgentAction } from "./parse";

export { mockRouter };

export const liveRouter: Router = async (req): Promise<LlmResponse> => {
  const started = Date.now();
  try {
    const res = await fetch("/api/agent/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: req.agentId,
        system: req.system,
        user: req.user,
        ...(req.jsonSchema !== undefined ? { jsonSchema: req.jsonSchema } : {}),
        // v2 — tiered routing; the proxy maps fast/smart to env models.
        ...(req.tier !== undefined ? { tier: req.tier } : {}),
      }),
    });

    if (!res.ok) {
      let message = `proxy returned HTTP ${res.status}`;
      try {
        const body = (await res.json()) as {
          error?: { message?: string; type?: string };
        };
        if (body?.error?.message) {
          message = body.error.type
            ? `${body.error.type}: ${body.error.message}`
            : body.error.message;
        }
      } catch {
        /* non-JSON error body — keep the status message */
      }
      return {
        raw: "",
        model: "unknown",
        latencyMs: Date.now() - started,
        error: message,
      };
    }

    const body = (await res.json()) as {
      raw?: unknown;
      model?: unknown;
      latencyMs?: unknown;
      tokensIn?: unknown;
      tokensOut?: unknown;
    };

    const response: LlmResponse = {
      raw: typeof body.raw === "string" ? body.raw : "",
      model: typeof body.model === "string" && body.model ? body.model : "unknown",
      latencyMs:
        typeof body.latencyMs === "number" ? body.latencyMs : Date.now() - started,
    };
    if (typeof body.tokensIn === "number") response.tokensIn = body.tokensIn;
    if (typeof body.tokensOut === "number") response.tokensOut = body.tokensOut;

    // Attach `parsed` only when extraction + validation succeeds.
    const parsed = parseAgentAction(response.raw);
    if (parsed) response.parsed = parsed;
    return response;
  } catch (err) {
    return {
      raw: "",
      model: "unknown",
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

/** Mock-first: live only when VITE_MODEL_MODE=live (contracts/README.md). */
export function getRouter(): Router {
  const mode =
    typeof import.meta !== "undefined" && import.meta.env
      ? import.meta.env.VITE_MODEL_MODE
      : undefined;
  return mode === "live" ? liveRouter : mockRouter;
}
