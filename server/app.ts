/**
 * Express app factory for the agent proxy — extracted from server/index.ts
 * (v2) so tests can mount the app in-process on an ephemeral port without
 * touching the real listener or the real upstream.
 *
 * Routes per contracts/openapi.yaml 2.0.0:
 *   GET  /api/health          liveness + upstream status + budget counters
 *   POST /api/agent/complete  one decision (v2: optional tier fast|smart)
 *   POST /api/embeddings      v2 batch embeddings (≤32 texts; NOT budgeted)
 */
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import cors from "cors";

import type { Budget } from "./llm/budget";
import { sanitizeErrorMessage } from "./llm/redact";
import {
  forwardCompletion,
  forwardEmbeddings,
  probeUpstream,
  type UpstreamConfig,
} from "./llm/upstream";
import type { ApiError, CompleteRequest, EmbedRequest } from "@contracts/types";

export const MAX_EMBED_TEXTS = 32;
export const MAX_EMBED_TEXT_LENGTH = 2_000;

function sendError(
  res: Response,
  status: number,
  type: ApiError["error"]["type"],
  message: string,
): void {
  const body: ApiError = { error: { message: sanitizeErrorMessage(message), type } };
  res.status(status).json(body);
}

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
  if (b.tier !== undefined && b.tier !== "fast" && b.tier !== "smart") {
    return '"tier" must be "fast" or "smart" when provided';
  }
  if (
    b.maxTokens !== undefined &&
    (typeof b.maxTokens !== "number" || !Number.isFinite(b.maxTokens) || b.maxTokens < 1)
  ) {
    return '"maxTokens" must be a positive number when provided';
  }
  return null;
}

/** Body validation per openapi.yaml: texts = 1..32 non-empty strings ≤2000 chars. */
function validateEmbedBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "request body must be a JSON object";
  }
  const texts = (body as Record<string, unknown>).texts;
  if (!Array.isArray(texts)) {
    return '"texts" is required and must be an array of strings';
  }
  if (texts.length < 1) {
    return '"texts" must contain at least 1 text';
  }
  if (texts.length > MAX_EMBED_TEXTS) {
    return `"texts" must contain at most ${MAX_EMBED_TEXTS} texts (got ${texts.length})`;
  }
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (typeof t !== "string" || t === "") {
      return `"texts[${i}]" must be a non-empty string`;
    }
    if (t.length > MAX_EMBED_TEXT_LENGTH) {
      return `"texts[${i}]" exceeds ${MAX_EMBED_TEXT_LENGTH} characters (got ${t.length})`;
    }
  }
  return null;
}

export function createApp(cfg: UpstreamConfig, budget: Budget): Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", async (_req, res) => {
    const upstream = await probeUpstream(cfg);
    res.json({
      status: "ok",
      upstream,
      decisionsToday: budget.decisionsToday(),
      dailyCeiling: budget.ceiling,
    });
  });

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

      const result = await forwardCompletion(cfg, body.system, body.user, body.tier);
      if (result.ok) {
        res.json(result.body);
      } else {
        res.status(result.status).json(result.body);
      }
    } catch (err) {
      sendError(res, 500, "server_error", err instanceof Error ? err.message : String(err));
    }
  });

  // v2 — batch embeddings. Same key secrecy + error envelope as complete;
  // embedding calls do NOT count toward the decision daily ceiling.
  app.post("/api/embeddings", async (req, res) => {
    try {
      const invalid = validateEmbedBody(req.body);
      if (invalid) {
        sendError(res, 400, "invalid_request_error", invalid);
        return;
      }
      const body = req.body as EmbedRequest;

      if (!cfg.apiKey) {
        sendError(
          res,
          401,
          "authentication_error",
          "FREELLMAPI_API_KEY is not configured on the proxy; embeddings unavailable",
        );
        return;
      }

      const result = await forwardEmbeddings(cfg, body.texts);
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

  return app;
}
