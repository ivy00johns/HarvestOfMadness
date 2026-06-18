/**
 * CognitionMeter — pure formatter for the cognition-cost HUD tally.
 *
 * Renders a compact right-aligned string for the badge row, distinct from the
 * decision-layer spend shown on agent cards (model/latency/tokens). This is the
 * generative-agents cognition LLM traffic: planning, reflection, importance
 * rating, relationship summaries.
 *
 * Format: `cog P{plan} R{reflect} I{importance} L{relationship} · {total}`.
 *
 * Graceful degradation (contract): in mock mode or when cognition is absent the
 * caller passes null/undefined → the zeroed form `"cog P0 R0 I0 L0 · 0"`. Never
 * throws, even on a partial/garbage object (missing counts coerce to 0).
 */
import type { CognitionMetrics } from "../agents/Cognition";

export interface CognitionMeterView {
  text: string;
  total: number;
}

/** Coerce an unknown field to a safe non-negative integer count (NaN → 0). */
function n(v: unknown): number {
  const x = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return x;
}

export function formatCognitionMeter(
  m: CognitionMetrics | null | undefined,
): CognitionMeterView {
  const plan = n(m?.planCalls);
  const reflect = n(m?.reflectionCalls);
  const importance = n(m?.importanceCalls);
  const relationship = n(m?.relationshipCalls);
  const total = plan + reflect + importance + relationship;
  return {
    text: `cog P${plan} R${reflect} I${importance} L${relationship} · ${total}`,
    total,
  };
}
