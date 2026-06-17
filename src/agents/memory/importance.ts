/**
 * Memory poignancy rating (contracts rule 9 + perf rules).
 *
 * Order of authority:
 *  1. the rule-9 heuristic table (rateImportanceMock) when it CLASSIFIES the
 *     text (gift 7 / harvest-fail 7 / talk 5 / routine 2) — $0, no call;
 *  2. the caller's hint (the cognition layer knows what kind of memory it is
 *     writing — routine results never reach the LLM, per the budget rule);
 *  3. live mode only: ONE fast-tier completion with buildImportancePrompt,
 *     parsed defensively (first integer, clamped 1–10), heuristic fallback
 *     on garbage/error;
 *  4. mock/offline: the heuristic default.
 *
 * NEVER routed through mockRouter (it only speaks AgentAction JSON).
 */
import type { Router } from "@contracts/types";
import { rateImportanceMock } from "../../llm/mock";
import { buildImportancePrompt } from "../../llm/prompts";

/** rateImportanceMock's "couldn't classify" default (see src/llm/mock.ts). */
export const HEURISTIC_UNCLASSIFIED = 3;

const IMPORTANCE_SYSTEM =
  "You rate the poignancy of an NPC farmer's memories. " +
  "Respond with ONLY a single integer from 1 to 10 — no prose, no fences.";

export interface ImportanceDeps {
  /** live-mode gate (same VITE_MODEL_MODE semantics the router uses) */
  live: () => boolean;
  /** live router for the fast-tier call (never mockRouter) */
  router: Router;
  /** optional metrics hook */
  onLiveCall?: () => void;
}

/** Clamp helper shared with tests. */
export function clampImportance(n: number): number {
  return Math.min(10, Math.max(1, Math.round(n)));
}

/**
 * Defensive integer extraction from raw model text: first integer found,
 * clamped to 1–10; null when no integer is present.
 */
export function parseImportanceInt(raw: string): number | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/-?\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  if (!Number.isFinite(n)) return null;
  return clampImportance(n);
}

export async function rateImportance(
  text: string,
  hint: number | undefined,
  deps: ImportanceDeps,
): Promise<number> {
  const heuristic = rateImportanceMock(text);
  if (heuristic !== HEURISTIC_UNCLASSIFIED) return heuristic; // classified — skip the LLM
  if (hint !== undefined) return clampImportance(hint);
  if (!deps.live()) return heuristic;

  try {
    deps.onLiveCall?.();
    const res = await deps.router({
      agentId: "cognition-importance",
      system: IMPORTANCE_SYSTEM,
      user: buildImportancePrompt(text),
      tier: "fast",
    });
    if (res.error) return heuristic;
    return parseImportanceInt(res.raw) ?? heuristic;
  } catch {
    return heuristic; // routers are documented never to throw — belt and braces
  }
}
