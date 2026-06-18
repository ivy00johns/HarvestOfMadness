/**
 * NeedsSystem (Wave 3a, PIANO keystone) — the intrinsic-drive layer that
 * makes `Agent.goal` dynamic. Five drives, each in [0,1] where HIGHER = more
 * pressing, so the dominant drive is the argmax. Drives feed goal synthesis
 * (Goals.ts) which in turn conditions the daily plan.
 *
 * Event-sourced, NO global tick:
 *  - recomputeFromState(agent): derive-on-read for energy/wealth from the
 *    agent's live energy/gold;
 *  - onOutcome(agent, action, result): refill social/purpose/novelty when an
 *    action SUCCEEDS (failed results never refill);
 *  - onDayAdvanced(name): the morning regen pulse for social/novelty/purpose.
 *
 * Every method is defensive — malformed input never throws (rule 10 spirit:
 * cognition must never block or break a decision). State reads return a
 * defensive COPY, lazily seeded from NEEDS_BASELINE. Fully deterministic:
 * no Math.random, no Date.now.
 */
import type { AgentAction, NeedState } from "@contracts/types";
import { ENERGY_START } from "@contracts/types";

/** Drive keys — also the deterministic tie-break order for dominant(). */
export const DRIVE_KEYS = [
  "energy",
  "wealth",
  "social",
  "novelty",
  "purpose",
] as const;

/** Lazy per-agent seed. wealth/purpose start middling, energy starts satisfied. */
export const NEEDS_BASELINE: NeedState = {
  energy: 0,
  wealth: 0.5,
  social: 0.3,
  novelty: 0.3,
  purpose: 0.5,
};

// -- tuning (pinned by spec) -------------------------------------------------
/** Gold above which the wealth drive is fully satisfied. */
export const WEALTH_COMFORT_GOLD = 500;
export const SOCIAL_DECAY_PER_PHASE = 0.12;
export const NOVELTY_DECAY_PER_PHASE = 0.1;
export const PURPOSE_REGEN_PER_DAY = 0.4;
export const SOCIAL_REFILL = 0.5;
export const PURPOSE_REFILL = 0.35;
export const NOVELTY_REFILL = 0.4;

/** A drive at or above this is "urgent" (used by goal-refresh cadence). */
export const DRIVE_URGENT = 0.75;

/** Clamp to [0,1]; NaN/non-number collapses to 0, ±Infinity clamps. Exported for tests. */
export function clamp01(v: number): number {
  if (typeof v !== "number" || Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Minimal structural shape the needs math reads off an Agent. */
interface NeedsAgentLike {
  name?: string;
  energy?: number;
  gold?: number;
}

function copyState(s: NeedState): NeedState {
  return {
    energy: s.energy,
    wealth: s.wealth,
    social: s.social,
    novelty: s.novelty,
    purpose: s.purpose,
  };
}

export class NeedsSystem {
  private readonly states = new Map<string, NeedState>();
  /** last successful action kind per agent — drives the novelty heuristic. */
  private readonly lastActionKind = new Map<string, string>();

  /** Lazily seed + return the LIVE state for an agent (internal, mutable). */
  private ensure(name: string): NeedState {
    let s = this.states.get(name);
    if (!s) {
      s = copyState(NEEDS_BASELINE);
      this.states.set(name, s);
    }
    return s;
  }

  /** Defensive COPY of an agent's drive vector (lazy baseline). Never throws. */
  state(name: string): NeedState {
    try {
      return copyState(this.ensure(name));
    } catch {
      return copyState(NEEDS_BASELINE);
    }
  }

  /**
   * Derive-on-read for the two drives that mirror live agent stats:
   *   energy = clamp01(1 - energy/ENERGY_START)   (high when exhausted)
   *   wealth = clamp01(1 - gold/WEALTH_COMFORT_GOLD) (high when poor)
   * The social/novelty/purpose drives are left untouched (event-sourced).
   */
  recomputeFromState(agent: NeedsAgentLike | null | undefined): void {
    try {
      if (!agent || typeof agent.name !== "string") return;
      const s = this.ensure(agent.name);
      const energy = typeof agent.energy === "number" ? agent.energy : ENERGY_START;
      const gold = typeof agent.gold === "number" ? agent.gold : 0;
      s.energy = clamp01(1 - energy / ENERGY_START);
      s.wealth = clamp01(1 - gold / WEALTH_COMFORT_GOLD);
    } catch {
      /* defensive — derive-on-read must never throw into enrichment */
    }
  }

  /**
   * Refill drives when an action SUCCEEDS. Failed results never refill.
   *  - TALK_TO / GIVE_GIFT → social -= SOCIAL_REFILL
   *  - HARVEST / SELL      → purpose -= PURPOSE_REFILL
   *  - action kind changed vs. last success → novelty -= NOVELTY_REFILL,
   *    else novelty += NOVELTY_DECAY_PER_PHASE (repetition is boring).
   */
  onOutcome(
    agent: NeedsAgentLike | null | undefined,
    action: AgentAction | { action?: unknown } | null | undefined,
    result: { ok?: boolean } | null | undefined,
  ): void {
    try {
      if (!agent || typeof agent.name !== "string") return;
      if (!result || result.ok !== true) return; // failed results don't refill
      const kind =
        action && typeof (action as { action?: unknown }).action === "string"
          ? ((action as { action: string }).action)
          : null;
      if (!kind) return;
      const s = this.ensure(agent.name);

      if (kind === "TALK_TO" || kind === "GIVE_GIFT") {
        s.social = clamp01(s.social - SOCIAL_REFILL);
      }
      if (kind === "HARVEST" || kind === "SELL") {
        s.purpose = clamp01(s.purpose - PURPOSE_REFILL);
      }

      const prev = this.lastActionKind.get(agent.name);
      if (prev !== kind) {
        s.novelty = clamp01(s.novelty - NOVELTY_REFILL);
      } else {
        s.novelty = clamp01(s.novelty + NOVELTY_DECAY_PER_PHASE);
      }
      this.lastActionKind.set(agent.name, kind);
    } catch {
      /* defensive — outcome bookkeeping must never throw into recordOutcome */
    }
  }

  /**
   * Morning regen pulse: a full day (4 phases) of accumulated social/novelty
   * pressure plus the daily purpose regen. Everything clamped to [0,1].
   */
  onDayAdvanced(name: string | null | undefined): void {
    try {
      if (typeof name !== "string") return;
      const s = this.ensure(name);
      s.social = clamp01(s.social + SOCIAL_DECAY_PER_PHASE * 4);
      s.novelty = clamp01(s.novelty + NOVELTY_DECAY_PER_PHASE * 4);
      s.purpose = clamp01(s.purpose + PURPOSE_REGEN_PER_DAY);
    } catch {
      /* defensive */
    }
  }

  /**
   * The most pressing drive (argmax). Ties broken by DRIVE_KEYS order
   * (energy > wealth > social > novelty > purpose). Deterministic.
   */
  dominant(name: string | null | undefined): (typeof DRIVE_KEYS)[number] {
    try {
      const s = typeof name === "string" ? this.ensure(name) : NEEDS_BASELINE;
      let best: (typeof DRIVE_KEYS)[number] = DRIVE_KEYS[0];
      let bestVal = s[DRIVE_KEYS[0]];
      for (const k of DRIVE_KEYS) {
        if (s[k] > bestVal) {
          best = k;
          bestVal = s[k];
        }
      }
      return best;
    } catch {
      return DRIVE_KEYS[0];
    }
  }
}
