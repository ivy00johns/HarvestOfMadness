/**
 * RolesSystem (Wave 4a) — emergent role specialization. The town reads an
 * agent's specialization off WHAT THEY ACTUALLY DO: a rolling histogram of
 * recent successful actions, bucketed into role-flavored work, plus a banker
 * overlay keyed on wealth. Roles are never seeded — a fresh agent is a
 * "farmer" and only earns another label by sustained behavior.
 *
 * Strictly additive subsystem, modeled on NeedsSystem/GoalsSystem: wired in
 * Cognition beside `needs`/`goals`, fed in recordOutcome, derived once per
 * game-day in onDayAdvanced, surfaced (cached read) in enrichObservation.
 *
 * Deterministic + defensive:
 *  - PURE integer-count argmax with a fixed priority tie-break; no Math.random,
 *    no Date.now;
 *  - hysteresis (a candidate must lead the current role by ROLE_HYSTERESIS_MARGIN
 *    of the window) + a MIN_SAMPLE floor smooth out thrash;
 *  - every method is try-wrapped and never throws into the decision loop.
 */
import type { AgentAction, DerivedRole } from "@contracts/types";
import { ROLE_VOCABULARY } from "@contracts/types";

/** The seed / default / fallback role. */
export const DEFAULT_ROLE: DerivedRole = "farmer";

/**
 * Which action kinds count toward which role bucket. Only the work that
 * SUCCEEDS is histogrammed (see onOutcome). WAIT/EMOTE/SLEEP are deliberately
 * absent (pure idling/flavor → no role signal).
 */
export const ACTION_ROLE_BUCKET: Readonly<Record<string, DerivedRole>> = {
  TILL: "farmer",
  PLANT: "farmer",
  WATER: "farmer",
  HARVEST: "farmer",
  BUY: "merchant",
  SELL: "merchant",
  TALK_TO: "socialite",
  GIVE_GIFT: "socialite",
  MOVE_TO: "wanderer",
  USE_OBJECT: "wanderer",
};

// -- tuning (pinned by spec) -------------------------------------------------
/** Rolling per-agent action window size (FIFO cap). */
export const ROLE_WINDOW = 24;
/** Below this many bucketed samples the agent stays "farmer". */
export const ROLE_MIN_SAMPLE = 8;
/**
 * A candidate role must lead the current role by at least this SHARE of the
 * window to flip the current role (hysteresis → no thrash).
 */
export const ROLE_HYSTERESIS_MARGIN = 0.15;
/** Gold at/above which the merchant-leaning agent reads as a "banker". */
export const BANKER_GOLD_THRESHOLD = 400;
/**
 * argmax tie-break order (farmer-first). banker is NOT here — it is a derived
 * overlay applied after the histogram argmax, not a histogram bucket.
 */
export const ROLE_PRIORITY: readonly DerivedRole[] = [
  "farmer",
  "merchant",
  "socialite",
  "wanderer",
];

/** Type guard: is a string a known role-bucket action kind? */
function bucketOf(kind: unknown): DerivedRole | null {
  if (typeof kind !== "string") return null;
  return ACTION_ROLE_BUCKET[kind] ?? null;
}

/** Minimal structural shape the roles math reads off an Agent. */
interface RolesAgentLike {
  name?: string;
  gold?: number;
}

export class RolesSystem {
  /** per-agent rolling FIFO of bucketed action kinds (cap ROLE_WINDOW). */
  private readonly windows = new Map<string, string[]>();
  /** per-agent current (hysteresis-gated) role. */
  private readonly current = new Map<string, DerivedRole>();

  /** Lazily fetch (or create) an agent's window. */
  private windowOf(name: string): string[] {
    let w = this.windows.get(name);
    if (!w) {
      w = [];
      this.windows.set(name, w);
    }
    return w;
  }

  /**
   * Record an action outcome. Only SUCCESSFUL, role-bucketed actions are
   * histogrammed; everything else (failures, WAIT/EMOTE/SLEEP, garbage) is
   * ignored. FIFO-evicts past ROLE_WINDOW. Never throws.
   */
  onOutcome(
    agent: RolesAgentLike | null | undefined,
    action: AgentAction | { action?: unknown } | null | undefined,
    result: { ok?: boolean } | null | undefined,
  ): void {
    try {
      if (!agent || typeof agent.name !== "string") return;
      if (!result || result.ok !== true) return; // failures never count
      const kind =
        action && typeof (action as { action?: unknown }).action === "string"
          ? (action as { action: string }).action
          : null;
      const bucket = bucketOf(kind);
      if (bucket === null) return; // not a role-bearing action
      const w = this.windowOf(agent.name);
      w.push(kind as string);
      while (w.length > ROLE_WINDOW) w.shift(); // rolling eviction
    } catch {
      /* defensive — role bookkeeping must never block a decision */
    }
  }

  /**
   * PURE derivation from the cached window + the given gold. Does NOT mutate
   * the current-role map (that is update()'s job). Returns DEFAULT_ROLE when:
   *  - the agent is unknown, OR
   *  - the window holds fewer than ROLE_MIN_SAMPLE bucketed actions.
   * Otherwise: argmax over role buckets (ties broken by ROLE_PRIORITY,
   * farmer-first), then the banker overlay — gold ≥ BANKER_GOLD_THRESHOLD AND
   * the merchant bucket is the top bucket OR at least ties the farmer bucket.
   */
  derive(name: string | null | undefined, gold: number): DerivedRole {
    try {
      if (typeof name !== "string") return DEFAULT_ROLE;
      const w = this.windows.get(name);
      if (!w || w.length < ROLE_MIN_SAMPLE) return DEFAULT_ROLE;

      // Integer histogram over role buckets (deterministic).
      const counts: Record<DerivedRole, number> = {
        farmer: 0,
        merchant: 0,
        socialite: 0,
        wanderer: 0,
        banker: 0, // never populated by buckets; overlay-only
      };
      for (const kind of w) {
        const bucket = ACTION_ROLE_BUCKET[kind];
        if (bucket) counts[bucket]++;
      }

      // argmax with ROLE_PRIORITY (farmer-first) tie-break.
      let best: DerivedRole = DEFAULT_ROLE;
      let bestCount = -1;
      for (const role of ROLE_PRIORITY) {
        if (counts[role] > bestCount) {
          best = role;
          bestCount = counts[role];
        }
      }

      // banker overlay: wealthy AND merchant-leaning (top bucket or ≥ farmer).
      const wealthy = typeof gold === "number" && gold >= BANKER_GOLD_THRESHOLD;
      const merchantLeaning =
        counts.merchant === bestCount || counts.merchant >= counts.farmer;
      if (wealthy && counts.merchant > 0 && merchantLeaning) {
        return "banker";
      }
      return best;
    } catch {
      return DEFAULT_ROLE;
    }
  }

  /**
   * The ONLY mutator. Derives the candidate role from the window + agent.gold,
   * then applies the hysteresis gate: the current role only flips when the
   * candidate leads it by ROLE_HYSTERESIS_MARGIN of the window's size (a
   * candidate that merely edges ahead does not thrash the label). Returns the
   * (possibly unchanged) current role. Never throws.
   */
  update(agent: RolesAgentLike | null | undefined): DerivedRole {
    try {
      if (!agent || typeof agent.name !== "string") return DEFAULT_ROLE;
      const name = agent.name;
      const gold = typeof agent.gold === "number" ? agent.gold : 0;
      const candidate = this.derive(name, gold);
      const cur = this.current.get(name) ?? DEFAULT_ROLE;

      if (candidate === cur) {
        this.current.set(name, cur);
        return cur;
      }

      // Hysteresis: flip only when the candidate's support leads the current
      // role's support by at least the margin share of the window.
      const w = this.windows.get(name) ?? [];
      const windowLen = w.length;
      const counts: Record<DerivedRole, number> = {
        farmer: 0,
        merchant: 0,
        socialite: 0,
        wanderer: 0,
        banker: 0,
      };
      for (const kind of w) {
        const bucket = ACTION_ROLE_BUCKET[kind];
        if (bucket) counts[bucket]++;
      }
      // The banker overlay rides the merchant bucket for support purposes.
      const supportOf = (role: DerivedRole): number =>
        role === "banker" ? counts.merchant : counts[role];

      const lead = supportOf(candidate) - supportOf(cur);
      const needed = Math.ceil(ROLE_HYSTERESIS_MARGIN * Math.max(1, windowLen));
      if (lead >= needed) {
        this.current.set(name, candidate);
        return candidate;
      }
      this.current.set(name, cur);
      return cur;
    } catch {
      return DEFAULT_ROLE;
    }
  }

  /** Cheap synchronous cached read — DEFAULT_ROLE until update() runs. */
  role(name: string | null | undefined): DerivedRole {
    try {
      if (typeof name !== "string") return DEFAULT_ROLE;
      return this.current.get(name) ?? DEFAULT_ROLE;
    } catch {
      return DEFAULT_ROLE;
    }
  }
}

/** Re-export for tests / callers that want the vocabulary locally. */
export { ROLE_VOCABULARY };
