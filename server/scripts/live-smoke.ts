/**
 * Live-mode smoke test (W3) — run with `npm run live:smoke` (tsx).
 *
 * Verifies the full key-present fast path end to end:
 *   env → proxy /api/health → (when upstream=ok) one REAL decision through
 *   POST /api/agent/complete with a canned farming observation, printing
 *   model / latency / tokens and the parsed AgentAction.
 *
 * Exits non-zero with a clear message when the proxy is down, FreeLLMAPI is
 * unreachable, or FREELLMAPI_API_KEY is missing/invalid (the HITL step —
 * see README "Going live").
 *
 * Requires the proxy to be running: `npm run dev:server` (or `npm run dev`).
 */
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { buildSystemPrompt, buildUserPrompt } from "../../src/llm/prompts";
import { parseAgentAction } from "../../src/llm/parse";
import type { CompleteResponse, Observation } from "@contracts/types";

// Same precedence as server/index.ts: server/.env wins, root .env fills gaps.
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

const PROXY = `http://localhost:${process.env.PORT ?? 8787}`;

function fail(message: string): never {
  console.error(`\n[live:smoke] FAIL — ${message}`);
  process.exit(1);
}

/** Canned mid-morning observation: seeds in pocket, one thirsty parsnip. */
function cannedObservation(): Observation {
  return {
    self: {
      name: "SmokeTestSam",
      persona: "Diligent smoke-test farmer — methodical, frugal",
      role: "farmer",
      pos: { x: 5, y: 5 },
      energy: 90,
      gold: 180,
      inventory: [{ itemId: "seed:parsnip", qty: 3 }],
      goal: "grow and sell parsnips",
    },
    time: { day: 2, phase: "morning" },
    nearby: {
      tiles: [
        { x: 5, y: 5, type: "grass" },
        { x: 5, y: 4, type: "tilled" },
        {
          x: 4,
          y: 5,
          type: "tilled",
          crop: { kind: "parsnip", stage: 1, watered: false, ready: false },
        },
        { x: 6, y: 5, type: "soil" },
      ],
      agents: [],
      landmarks: [
        { kind: "bed", pos: { x: 2, y: 2 } },
        { kind: "shop", pos: { x: 10, y: 5 } },
      ],
    },
    lastAction: { action: "PLANT", ok: true },
    availableActions: [
      "MOVE_TO",
      "TILL",
      "PLANT",
      "WATER",
      "HARVEST",
      "BUY",
      "SELL",
      "TALK_TO",
      "WAIT",
    ],
    economy: {
      sells: { "crop:parsnip": 35, "crop:potato": 80, "crop:cauliflower": 175 },
      buys: { "seed:parsnip": 20, "seed:potato": 40, "seed:cauliflower": 80 },
    },
  };
}

async function main(): Promise<void> {
  console.log(`[live:smoke] proxy: ${PROXY}`);
  console.log(
    `[live:smoke] FREELLMAPI_API_KEY: ${process.env.FREELLMAPI_API_KEY ? "present" : "MISSING"}`,
  );

  // 1. Health.
  let health: { status: string; upstream: string; decisionsToday: number; dailyCeiling: number };
  try {
    const res = await fetch(`${PROXY}/api/health`, { signal: AbortSignal.timeout(5_000) });
    health = (await res.json()) as typeof health;
  } catch {
    fail(`proxy not reachable at ${PROXY} — start it first: npm run dev:server`);
  }
  console.log(`[live:smoke] /api/health → ${JSON.stringify(health)}`);

  if (health.upstream === "unreachable") {
    fail(
      `FreeLLMAPI is not reachable from the proxy (FREELLMAPI_BASE_URL=${
        process.env.FREELLMAPI_BASE_URL ?? "http://127.0.0.1:3001"
      }). Is the Docker instance running?`,
    );
  }
  if (health.upstream === "unauthorized") {
    fail(
      "FREELLMAPI_API_KEY is missing or invalid. Get the unified key from the FreeLLMAPI " +
        "dashboard at http://localhost:3001, write it into server/.env as " +
        "FREELLMAPI_API_KEY=..., restart the proxy, then re-run npm run live:smoke.",
    );
  }
  if (health.upstream !== "ok") {
    fail(`unexpected upstream state "${health.upstream}"`);
  }

  // 2. One real decision through the proxy.
  console.log("[live:smoke] upstream=ok — requesting one real decision...");
  const obs = cannedObservation();
  const started = Date.now();
  const res = await fetch(`${PROXY}/api/agent/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: obs.self.name,
      system: buildSystemPrompt(obs.self.persona),
      user: buildUserPrompt(obs),
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const text = await res.text();
    fail(`POST /api/agent/complete → HTTP ${res.status}: ${text}`);
  }

  const body = (await res.json()) as CompleteResponse;
  console.log("\n[live:smoke] PASS — completion received");
  console.log(`  model:      ${body.model}`);
  console.log(`  latencyMs:  ${body.latencyMs} (round-trip ${Date.now() - started}ms)`);
  console.log(`  tokensIn:   ${body.tokensIn ?? "n/a"}`);
  console.log(`  tokensOut:  ${body.tokensOut ?? "n/a"}`);

  const parsed = parseAgentAction(body.raw);
  if (parsed) {
    console.log(`  action:     ${JSON.stringify(parsed)}`);
  } else {
    console.log(`  action:     PARSE FAILED — raw response below`);
    console.log(`  raw:        ${body.raw.slice(0, 500)}`);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
