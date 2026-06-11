/**
 * Harvest of Madness — agent proxy (llm-agent, W1).
 *
 * Thin Express proxy per contracts/openapi.yaml. Holds the FreeLLMAPI
 * unified key server-side (server/.env — it must NEVER reach src/ or the
 * Vite bundle) and forwards agent decision requests to the running
 * FreeLLMAPI instance. Degrades gracefully while the key is absent:
 * /api/health reports upstream "unauthorized" and /api/agent/complete
 * returns a sanitized 401 authentication_error.
 */
import { fileURLToPath } from "node:url";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";

import { createBudget } from "./llm/budget";
import { sanitizeErrorMessage } from "./llm/redact";
import { forwardCompletion, probeUpstream, type UpstreamConfig } from "./llm/upstream";
import type { ApiError, CompleteRequest } from "@contracts/types";

// server/.env first (wins), then repo-root .env (fills gaps).
dotenv.config({ path: fileURLToPath(new URL(".env", import.meta.url)) });
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const cfg: UpstreamConfig = {
  baseUrl: (process.env.FREELLMAPI_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, ""),
  apiKey: process.env.FREELLMAPI_API_KEY ?? "",
  model: process.env.FREELLMAPI_MODEL || "auto",
};

const DAILY_CEILING = Number(process.env.DAILY_CEILING ?? 200);
const budget = createBudget(Number.isFinite(DAILY_CEILING) && DAILY_CEILING > 0 ? DAILY_CEILING : 200);

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

function sendError(
  res: Response,
  status: number,
  type: ApiError["error"]["type"],
  message: string,
): void {
  const body: ApiError = { error: { message: sanitizeErrorMessage(message), type } };
  res.status(status).json(body);
}

app.get("/api/health", async (_req, res) => {
  const upstream = await probeUpstream(cfg);
  res.json({
    status: "ok",
    upstream,
    decisionsToday: budget.decisionsToday(),
    dailyCeiling: budget.ceiling,
  });
});

/** Body validation per openapi.yaml: agentId/system/user required strings. */
function validateCompleteBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "request body must be a JSON object";
  }
  const b = body as Record<string, unknown>;
  for (const field of ["agentId", "system", "user"] as const) {
    if (typeof b[field] !== "string" || b[field] === "") {
      return `"${field}" is required and must be a non-empty string`;
    }
  }
  if (b.jsonSchema !== undefined && (typeof b.jsonSchema !== "object" || b.jsonSchema === null)) {
    return '"jsonSchema" must be an object when provided';
  }
  return null;
}

app.post("/api/agent/complete", async (req, res) => {
  try {
    const invalid = validateCompleteBody(req.body);
    if (invalid) {
      sendError(res, 400, "invalid_request_error", invalid);
      return;
    }
    const body = req.body as CompleteRequest;

    if (!cfg.apiKey) {
      // Key not configured yet (server/.env) — degrade gracefully, no upstream call.
      sendError(
        res,
        401,
        "authentication_error",
        "FREELLMAPI_API_KEY is not configured on the proxy; live mode unavailable",
      );
      return;
    }

    // UTC-day decision ceiling — past it, 429 WITHOUT calling upstream.
    if (!budget.tryConsume()) {
      sendError(
        res,
        429,
        "budget_exceeded",
        `daily decision ceiling reached (${budget.ceiling}); resumes next UTC day`,
      );
      return;
    }

    const result = await forwardCompletion(cfg, body.system, body.user);
    if (result.ok) {
      res.json(result.body);
    } else {
      res.status(result.status).json(result.body);
    }
  } catch (err) {
    sendError(res, 500, "server_error", err instanceof Error ? err.message : String(err));
  }
});

// Malformed JSON from express.json() (and anything else thrown synchronously)
// still gets the ApiError envelope, sanitized.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = (err as { status?: number })?.status;
  if (status === 400 || (err as { type?: string })?.type === "entity.parse.failed") {
    sendError(res, 400, "invalid_request_error", "request body is not valid JSON");
    return;
  }
  sendError(res, 500, "server_error", err instanceof Error ? err.message : String(err));
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(
    `[server] agent proxy on http://localhost:${port} → ${cfg.baseUrl} ` +
      `(model=${cfg.model}, key=${cfg.apiKey ? "present" : "MISSING"}, ceiling=${budget.ceiling})`,
  );
});
