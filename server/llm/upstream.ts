/**
 * FreeLLMAPI upstream client — health probes + chat-completion forwarding.
 *
 * Upstream facts (verified): OpenAI-compatible POST /v1/chat/completions with
 * `Authorization: Bearer <key>`; `model:"auto"` lets it route; the actual
 * servicing model comes back in the `X-Routed-Via` response header (fallback:
 * body.model); token usage in body.usage.{prompt_tokens,completion_tokens};
 * unauthenticated liveness at GET /api/ping; errors are
 * `{error:{message,type}}`; 429 on exhaustion.
 */

import { contentToString } from "./content";
import { sanitizeErrorMessage } from "./redact";
import type { ApiError, CompleteResponse, EmbedResponse } from "@contracts/types";

export interface UpstreamConfig {
  baseUrl: string; // e.g. http://127.0.0.1:3001
  apiKey: string; // empty string when not configured yet
  model: string; // default "auto" — used when no tier is requested
  /** v2 tier "fast" (FREELLMAPI_MODEL_FAST); falls back to `model` */
  modelFast?: string;
  /** v2 tier "smart" (FREELLMAPI_MODEL_SMART); falls back to `model` */
  modelSmart?: string;
  /** v2 embeddings model (FREELLMAPI_EMBED_MODEL); default "auto" */
  embedModel?: string;
}

/** v2 tier → model mapping; omitted tier = exactly v1 behavior. */
export function modelForTier(cfg: UpstreamConfig, tier?: "fast" | "smart"): string {
  if (tier === "fast") return cfg.modelFast || cfg.model;
  if (tier === "smart") return cfg.modelSmart || cfg.model;
  return cfg.model;
}

export type UpstreamHealth = "ok" | "unreachable" | "unauthorized";

const PROBE_TIMEOUT_MS = 3_000;
const COMPLETE_TIMEOUT_MS = 30_000;

/**
 * GET /api/ping (unauthenticated) → "unreachable" on failure; then
 * "unauthorized" when the key is missing or a GET /v1/models probe with the
 * key returns 401; else "ok".
 */
export async function probeUpstream(cfg: UpstreamConfig): Promise<UpstreamHealth> {
  try {
    const ping = await fetch(`${cfg.baseUrl}/api/ping`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!ping.ok) return "unreachable";
  } catch {
    return "unreachable";
  }

  if (!cfg.apiKey) return "unauthorized";

  try {
    const models = await fetch(`${cfg.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (models.status === 401) return "unauthorized";
    if (!models.ok) return "unreachable";
    return "ok";
  } catch {
    return "unreachable";
  }
}

export type ForwardResult =
  | { ok: true; body: CompleteResponse }
  | { ok: false; status: number; body: ApiError };

function apiError(
  status: number,
  type: ApiError["error"]["type"],
  message: unknown,
): { ok: false; status: number; body: ApiError } {
  return {
    ok: false,
    status,
    body: { error: { message: sanitizeErrorMessage(message), type } },
  };
}

/** Pull a human-readable message out of an upstream error body, defensively. */
async function upstreamErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (parsed?.error?.message != null) return String(parsed.error.message);
    } catch {
      /* not JSON — fall through to raw text */
    }
    if (text) return text;
  } catch {
    /* unreadable body */
  }
  return `upstream HTTP ${res.status}`;
}

/**
 * Forward one decision to POST /v1/chat/completions. Maps upstream
 * 401→401 authentication_error, 429→429 rate_limit_error, network/5xx/other
 * →502 upstream_error. All messages sanitized.
 */
export async function forwardCompletion(
  cfg: UpstreamConfig,
  system: string,
  user: string,
  tier?: "fast" | "smart",
): Promise<ForwardResult> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: modelForTier(cfg, tier),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
    });
  } catch (err) {
    return apiError(502, "upstream_error", err instanceof Error ? err.message : err);
  }

  if (res.status === 401) {
    return apiError(401, "authentication_error", await upstreamErrorMessage(res));
  }
  if (res.status === 429) {
    return apiError(429, "rate_limit_error", await upstreamErrorMessage(res));
  }
  if (!res.ok) {
    return apiError(502, "upstream_error", await upstreamErrorMessage(res));
  }

  let body: {
    model?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    return apiError(502, "upstream_error", err instanceof Error ? err.message : err);
  }

  const raw = contentToString(body?.choices?.[0]?.message?.content);
  const routedVia = res.headers.get("x-routed-via");
  const model =
    routedVia || (typeof body?.model === "string" && body.model ? body.model : "unknown");

  const out: CompleteResponse = {
    raw,
    model,
    latencyMs: Date.now() - started,
  };
  const tokensIn = body?.usage?.prompt_tokens;
  const tokensOut = body?.usage?.completion_tokens;
  if (typeof tokensIn === "number") out.tokensIn = tokensIn;
  if (typeof tokensOut === "number") out.tokensOut = tokensOut;
  return { ok: true, body: out };
}

export type EmbedForwardResult =
  | { ok: true; body: EmbedResponse }
  | { ok: false; status: number; body: ApiError };

/**
 * Forward one embeddings batch to POST /v1/embeddings (OpenAI-compatible:
 * `{model, input}` → `{data:[{index, embedding}], model}`). Same error
 * mapping + sanitization as forwardCompletion; model from X-Routed-Via when
 * present, else body.model. Output order follows `data[].index` so it always
 * matches the input order.
 */
export async function forwardEmbeddings(
  cfg: UpstreamConfig,
  texts: string[],
): Promise<EmbedForwardResult> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.embedModel || "auto",
        input: texts,
      }),
      signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
    });
  } catch (err) {
    return apiError(502, "upstream_error", err instanceof Error ? err.message : err);
  }

  if (res.status === 401) {
    return apiError(401, "authentication_error", await upstreamErrorMessage(res));
  }
  if (res.status === 429) {
    return apiError(429, "rate_limit_error", await upstreamErrorMessage(res));
  }
  if (!res.ok) {
    return apiError(502, "upstream_error", await upstreamErrorMessage(res));
  }

  let body: {
    model?: unknown;
    data?: Array<{ index?: unknown; embedding?: unknown }>;
  };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    return apiError(502, "upstream_error", err instanceof Error ? err.message : err);
  }

  const data = Array.isArray(body?.data) ? body.data : null;
  if (data === null) {
    return apiError(502, "upstream_error", "upstream embeddings response missing data array");
  }

  // Order by index when provided (OpenAI guarantees it; be defensive anyway).
  const ordered = [...data].sort(
    (a, b) =>
      (typeof a.index === "number" ? a.index : 0) - (typeof b.index === "number" ? b.index : 0),
  );
  const embeddings: number[][] = [];
  for (const row of ordered) {
    const vec = row?.embedding;
    if (!Array.isArray(vec) || vec.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      return apiError(502, "upstream_error", "upstream returned a malformed embedding vector");
    }
    embeddings.push(vec as number[]);
  }
  if (embeddings.length !== texts.length) {
    return apiError(
      502,
      "upstream_error",
      `upstream returned ${embeddings.length} embeddings for ${texts.length} texts`,
    );
  }

  const routedVia = res.headers.get("x-routed-via");
  const model =
    routedVia || (typeof body?.model === "string" && body.model ? body.model : "unknown");
  return { ok: true, body: { embeddings, model } };
}
