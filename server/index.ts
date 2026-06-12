/**
 * Harvest of Madness — agent proxy entrypoint (llm-agent W1; v2 tiering +
 * embeddings by server-llm-agent vW1).
 *
 * Thin Express proxy per contracts/openapi.yaml. Holds the FreeLLMAPI
 * unified key server-side (server/.env — it must NEVER reach src/ or the
 * Vite bundle) and forwards agent decision + embedding requests to the
 * running FreeLLMAPI instance. Degrades gracefully while the key is absent:
 * /api/health reports upstream "unauthorized" and the POST routes return a
 * sanitized 401 authentication_error.
 *
 * Routes live in server/app.ts (createApp) so tests can mount the app
 * in-process; this file only loads env, builds the config, and listens.
 */
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { createApp } from "./app";
import { createBudget } from "./llm/budget";
import type { UpstreamConfig } from "./llm/upstream";

// server/.env first (wins), then repo-root .env (fills gaps).
dotenv.config({ path: fileURLToPath(new URL(".env", import.meta.url)) });
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const baseModel = process.env.FREELLMAPI_MODEL || "auto";
const cfg: UpstreamConfig = {
  baseUrl: (process.env.FREELLMAPI_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, ""),
  apiKey: process.env.FREELLMAPI_API_KEY ?? "",
  model: baseModel,
  // v2 tiered routing — both default to the existing FREELLMAPI_MODEL || "auto".
  modelFast: process.env.FREELLMAPI_MODEL_FAST || baseModel,
  modelSmart: process.env.FREELLMAPI_MODEL_SMART || baseModel,
  // v2 embeddings model — default "auto".
  embedModel: process.env.FREELLMAPI_EMBED_MODEL || "auto",
};

const DAILY_CEILING = Number(process.env.DAILY_CEILING ?? 200);
const budget = createBudget(Number.isFinite(DAILY_CEILING) && DAILY_CEILING > 0 ? DAILY_CEILING : 200);

const app = createApp(cfg, budget);

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(
    `[server] agent proxy on http://localhost:${port} → ${cfg.baseUrl} ` +
      `(model=${cfg.model}, fast=${cfg.modelFast}, smart=${cfg.modelSmart}, ` +
      `embed=${cfg.embedModel}, key=${cfg.apiKey ? "present" : "MISSING"}, ceiling=${budget.ceiling})`,
  );
});
