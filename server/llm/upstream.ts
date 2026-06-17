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

/** Default completion token cap when a request omits maxTokens. */
export const DEFAULT_MAX_TOKENS = 1024;
/** Output-variety temperature (deep-research-v3 pattern 10). */
const COMPLETION_TEMPERATURE = 0.75;

/**
 * Bounded `auto` retry lane (resilience). FreeLLMAPI's `model:"auto"` re-routes
 * to a (frequently different) provider on every call, so a transient single-
 * provider 5xx/429/network blip is recovered simply by trying "auto" again —
 * turning a momentary outage into a successful decision instead of a mock-mode
 * fallback. Sequential (one call per retry), never a fan-out.
 */
const AUTO_BACKUP_RETRIES = 2;
/** Per-retry backoff (ms); the first retry is immediate so a re-route is instant. */
const RETRY_BACKOFF_MS = [0, 300] as const;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * JSON-mode sticky degrade (pattern 5): we send response_format json_object by
 * default. The FIRST time a provider rejects it (a 400/404/422 whose message
 * mentions response_format / json), we flip this off for the rest of the
 * PROCESS lifetime so we stop paying a wasted round-trip on every call.
 */
let jsonModeEnabled = true;

/** Test-only reset for the process-lifetime json-mode latch. */
export function __resetJsonModeForTests(): void {
  jsonModeEnabled = true;
}

/** Heuristic: does this upstream error look like a json-mode rejection? */
function looksLikeJsonModeRejection(status: number, message: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  const m = message.toLowerCase();
  return m.includes("response_format") || m.includes("json_object") || m.includes("json mode");
}

/** Heuristic: does this upstream error mean "the pinned model is unknown"? */
function looksLikeModelNotFound(status: number, message: string): boolean {
  if (status !== 400 && status !== 404) return false;
  const m = message.toLowerCase();
  return (
    m.includes("model not found") ||
    m.includes("unknown model") ||
    m.includes("does not exist") ||
    m.includes("no such model") ||
    (m.includes("model") && (m.includes("not found") || m.includes("invalid")))
  );
}

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

/** Outcome of ONE chat-completion attempt against a single model. */
type AttemptOk = {
  ok: true;
  body: CompleteResponse;
};
type AttemptFail = {
  ok: false;
  status: number;
  type: ApiError["error"]["type"];
  message: string;
  /** retryable on the `auto` backup lane (network/5xx/429/model-not-found) */
  bounceable: boolean;
};
type Attempt = AttemptOk | AttemptFail;

/**
 * One chat-completion POST against `model`. Returns a structured Attempt so
 * the orchestrator (forwardCompletion) can decide whether to bounce to the
 * `auto` backup, retry without json-mode, or propagate.
 */
async function attemptCompletion(
  cfg: UpstreamConfig,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  useJsonMode: boolean,
): Promise<Attempt> {
  const started = Date.now();

  // Pattern 6: only set Authorization when the trimmed key is non-empty —
  // an empty header value throws "Illegal header value" on some fetch impls.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = cfg.apiKey?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;

  const payload: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    max_tokens: maxTokens,
    temperature: COMPLETION_TEMPERATURE,
  };
  if (useJsonMode) payload.response_format = { type: "json_object" };

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
    });
  } catch (err) {
    // Network/timeout — bounceable.
    return {
      ok: false,
      status: 502,
      type: "upstream_error",
      message: err instanceof Error ? err.message : String(err),
      bounceable: true,
    };
  }

  if (!res.ok) {
    const message = await upstreamErrorMessage(res);
    if (res.status === 401) {
      // Auth is never bounceable — the same key fails on every lane.
      return { ok: false, status: 401, type: "authentication_error", message, bounceable: false };
    }
    if (res.status === 429) {
      return { ok: false, status: 429, type: "rate_limit_error", message, bounceable: true };
    }
    // 5xx and model-not-found 400/404 bounce; other 4xx propagate as 502.
    const bounceable = res.status >= 500 || looksLikeModelNotFound(res.status, message);
    return { ok: false, status: 502, type: "upstream_error", message, bounceable };
  }

  let body: {
    model?: unknown;
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    return {
      ok: false,
      status: 502,
      type: "upstream_error",
      message: err instanceof Error ? err.message : String(err),
      bounceable: true,
    };
  }

  const raw = contentToString(body?.choices?.[0]?.message?.content);
  const routedVia = res.headers.get("x-routed-via");
  const routedModel =
    routedVia || (typeof body?.model === "string" && body.model ? body.model : "unknown");

  const out: CompleteResponse = {
    raw,
    model: routedModel,
    latencyMs: Date.now() - started,
  };
  const tokensIn = body?.usage?.prompt_tokens;
  const tokensOut = body?.usage?.completion_tokens;
  if (typeof tokensIn === "number") out.tokensIn = tokensIn;
  if (typeof tokensOut === "number") out.tokensOut = tokensOut;
  const finishReason = body?.choices?.[0]?.finish_reason;
  if (typeof finishReason === "string") out.finishReason = finishReason;
  return { ok: true, body: out };
}

/**
 * Forward one decision to POST /v1/chat/completions, with battle-tested
 * resilience (deep-research-v3 port). Maps upstream 401→401
 * authentication_error, 429→429 rate_limit_error, network/5xx/other →502
 * upstream_error. All messages sanitized.
 *
 * Resilience layers, applied to the HOME call (modelForTier):
 *  - max_tokens (request value or DEFAULT_MAX_TOKENS), temperature, and
 *    response_format json_object (pattern 4/10/5).
 *  - JSON-mode STICKY DEGRADE (pattern 5): a json-mode rejection retries the
 *    SAME model once without response_format AND latches json-mode off for the
 *    process. This does NOT consume the auto retries.
 *  - BOUNDED `auto` RETRY LANE: on a bounceable failure (network/5xx/429/
 *    model-not-found) we retry up to AUTO_BACKUP_RETRIES times with model:"auto",
 *    sequentially (never a fan-out). "auto" re-routes per call, so this recovers
 *    transient single-provider blips even when the home model already IS "auto".
 *    401 auth never bounces and stops the loop. When the home model was a pinned
 *    tier, a recovered call records bouncedFrom = home model, bouncedTo = routed.
 */
export async function forwardCompletion(
  cfg: UpstreamConfig,
  system: string,
  user: string,
  tier?: "fast" | "smart",
  maxTokens?: number,
): Promise<ForwardResult> {
  const homeModel = modelForTier(cfg, tier);
  const cap = typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS;

  // --- HOME call (with json-mode sticky degrade) -------------------------
  let home = await attemptCompletion(cfg, homeModel, system, user, cap, jsonModeEnabled);

  // JSON-mode sticky degrade: attemptCompletion collapses the raw upstream
  // status (a 4xx response_format rejection becomes a mapped 502/upstream_error
  // here), so we re-derive intent from the message. On a json-mode rejection,
  // latch json-mode OFF for the process and retry the SAME model once without
  // it — this does NOT consume the auto backup.
  if (
    !home.ok &&
    jsonModeEnabled &&
    home.type === "upstream_error" &&
    looksLikeJsonModeRejection(400, home.message)
  ) {
    jsonModeEnabled = false;
    home = await attemptCompletion(cfg, homeModel, system, user, cap, false);
  }

  if (home.ok) return { ok: true, body: home.body };

  // --- bounded `auto` retry lane (sequential, never a fan-out) -----------
  // A non-bounceable failure (401 auth, or a non-model 4xx) is terminal.
  if (!home.bounceable) {
    return { ok: false, status: home.status, body: errBody(home.type, home.message) };
  }

  // Retry on "auto" — it re-routes per call, so repeated tries hit different
  // providers. Applies whether the home model was a pinned tier OR "auto"
  // itself (a second "auto" is NOT the identical call). 401 stops the loop.
  let last: AttemptFail = home;
  for (let i = 0; i < AUTO_BACKUP_RETRIES; i++) {
    if (RETRY_BACKOFF_MS[i] > 0) await delay(RETRY_BACKOFF_MS[i]);
    const retry = await attemptCompletion(cfg, "auto", system, user, cap, jsonModeEnabled);
    if (retry.ok) {
      if (homeModel !== "auto") {
        retry.body.bouncedFrom = homeModel;
        retry.body.bouncedTo = retry.body.model;
      }
      return { ok: true, body: retry.body };
    }
    last = retry;
    if (!retry.bounceable) break; // terminal (e.g. 401 on the retry) — stop early
  }

  // Every attempt failed — propagate the freshest error.
  return { ok: false, status: last.status, body: errBody(last.type, last.message) };
}

function errBody(type: ApiError["error"]["type"], message: string): ApiError {
  return { error: { message: sanitizeErrorMessage(message), type } };
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
