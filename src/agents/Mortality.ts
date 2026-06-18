/**
 * MortalitySystem — death, suicide (despair), and murder as a DETERMINISTIC,
 * conservative simulation mechanic (this is a dark farming-sim; mortality is
 * in-world game logic). Modeled on RolesSystem / NeedsSystem: pure, no
 * Math.random / Date.now, per-agent crisis counters, every method try-wrapped
 * so nothing ever throws into the decision loop, and driven once per game-day
 * (onDayAdvanced cadence) from CognitionSystem.
 *
 * `evaluate(agents, day, affinity)` is PURE per call: it advances per-agent
 * crisis counters from the agents' live state, then returns the Deaths that
 * fired this day. It does NOT mutate the agents — the caller (Cognition) sets
 * alive / causeOfDeath / deathDay and emits the feed event. Two runs over the
 * same inputs produce byte-identical Deaths.
 *
 * Thresholds are CONSERVATIVE BY DESIGN: an agent behaving normally (sleeping
 * to recover energy each night, neutral/positive relationships, nonzero gold)
 * NEVER dies. A single good night's sleep (energy back up) resets the
 * starvation/despair counters. Murder needs a strong negative grudge well
 * below anything TALK_TO (+2) ever produces, plus Chebyshev adjacency.
 */

import { ENERGY_START } from "@contracts/types";

// -- tuning (pinned, conservative) -------------------------------------------

/** STARVATION: energy at/below this counts as a starving day-evaluation. */
export const STARVE_ENERGY = 3;
/** STARVATION fires after this many CONSECUTIVE starving day-evaluations. */
export const STARVE_DAYS = 4;

/**
 * DESPAIR (suicide) gates — ALL must hold for a day to count toward despair.
 * Conservative: a normal agent (rested → high energy, nonzero gold, neutral or
 * positive ties) fails the very first gate, so the despair counter never even
 * starts, let alone sustains.
 */
export const DESPAIR_ENERGY = 5;
/** A drive at/above this is "in crisis" for despair scoring (mirrors DRIVE_URGENT). */
export const DESPAIR_NEED_CRISIS = 0.85;
/** Despair requires at least this many drives in crisis. */
export const DESPAIR_MIN_CRISIS_NEEDS = 2;
/** Despair requires the agent's strongest social tie to be at/below this affinity. */
export const DESPAIR_MAX_AFFINITY = 0;
/** Despair requires gold strictly below this. */
export const DESPAIR_MAX_GOLD = 1;
/** DESPAIR fires after this many CONSECUTIVE despairing day-evaluations. */
export const DESPAIR_DAYS = 4;

/**
 * MURDER: A murders an ADJACENT (Chebyshev<=1) living agent B when A's affinity
 * toward B is at/below this strong negative grudge. The grudge floor is far
 * below anything TALK_TO (+2) / GIVE_GIFT (+10) ever produces, so in normal
 * mock runs (neutral/positive relationships) murder NEVER fires.
 */
export const MURDER_GRUDGE = -60;

import type { Vec2 } from "@contracts/types";

/** A death surfaced this evaluation. `by` is set only for murder (the killer). */
export interface Death {
  name: string;
  cause: "starvation" | "despair" | "murder";
  by?: string;
}

/** Minimal structural shape the mortality math reads off an Agent. */
export interface MortalAgentLike {
  name?: string;
  alive?: boolean;
  energy?: number;
  gold?: number;
  pos?: Vec2;
  needs?: {
    energy?: number;
    wealth?: number;
    social?: number;
    novelty?: number;
    purpose?: number;
  } | null;
}

/** Affinity lookup: A's affinity toward B (or null when no relationship). */
export type AffinityLookup = (
  fromName: string,
  toName: string,
) => number | null;

/** Chebyshev (8-neighbour) distance — local copy to keep this module standalone. */
function chebyshev(a: Vec2 | undefined, b: Vec2 | undefined): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dx = typeof a.x === "number" && typeof b.x === "number" ? Math.abs(a.x - b.x) : Number.POSITIVE_INFINITY;
  const dy = typeof a.y === "number" && typeof b.y === "number" ? Math.abs(a.y - b.y) : Number.POSITIVE_INFINITY;
  return Math.max(dx, dy);
}

function isLiving(a: MortalAgentLike | null | undefined): a is MortalAgentLike {
  return !!a && typeof a.name === "string" && a.alive !== false;
}

export class MortalitySystem {
  /** Consecutive starving day-evaluations, per agent. */
  private readonly starveCount = new Map<string, number>();
  /** Consecutive despairing day-evaluations, per agent. */
  private readonly despairCount = new Map<string, number>();
  /** Names already returned as dead — never re-reported. */
  private readonly dead = new Set<string>();

  /** Has this agent already been reported dead by a prior evaluation? */
  isAlive(name: string | null | undefined): boolean {
    try {
      return typeof name === "string" ? !this.dead.has(name) : true;
    } catch {
      return true;
    }
  }

  /** Reset a single agent's crisis bookkeeping (test / respawn hook). */
  reset(name: string | null | undefined): void {
    try {
      if (typeof name !== "string") return;
      this.starveCount.delete(name);
      this.despairCount.delete(name);
      this.dead.delete(name);
    } catch {
      /* defensive */
    }
  }

  /** Whole-system reset (tests). */
  resetAll(): void {
    try {
      this.starveCount.clear();
      this.despairCount.clear();
      this.dead.clear();
    } catch {
      /* defensive */
    }
  }

  /** Count how many of an agent's drives are in crisis (>= DESPAIR_NEED_CRISIS). */
  private crisisNeedCount(needs: MortalAgentLike["needs"]): number {
    if (!needs || typeof needs !== "object") return 0;
    let n = 0;
    for (const k of ["energy", "wealth", "social", "novelty", "purpose"] as const) {
      const v = needs[k];
      if (typeof v === "number" && v >= DESPAIR_NEED_CRISIS) n++;
    }
    return n;
  }

  /**
   * The agent's strongest (most-positive) social tie affinity toward any OTHER
   * living agent. Returns null when the agent has no relationship to any living
   * peer (treated as "no positive support" by the despair gate's caller).
   */
  private strongestTie(
    name: string,
    living: MortalAgentLike[],
    affinity: AffinityLookup,
  ): number | null {
    let best: number | null = null;
    for (const other of living) {
      if (other.name === name || typeof other.name !== "string") continue;
      let a: number | null;
      try {
        a = affinity(name, other.name);
      } catch {
        a = null;
      }
      if (a === null || typeof a !== "number") continue;
      if (best === null || a > best) best = a;
    }
    return best;
  }

  /**
   * PURE, deterministic per-call. Advances per-agent crisis counters from the
   * living agents' live state and returns the Deaths that fired THIS day.
   * Never mutates the agents; never throws. Deterministic ordering: results are
   * sorted by name so two runs over identical inputs are byte-identical.
   *
   * @param agents   all agents (dead are skipped via isLiving / alive flag)
   * @param day      current game-day (carried onto Death-derived bus text by caller)
   * @param affinity A's affinity toward B for murder grudges + despair ties
   */
  evaluate(
    agents: readonly MortalAgentLike[] | null | undefined,
    day: number,
    affinity: AffinityLookup,
  ): Death[] {
    const deaths: Death[] = [];
    try {
      void day; // part of the pinned signature; the caller carries it onto the feed
      if (!Array.isArray(agents)) return deaths;
      const safeAffinity: AffinityLookup =
        typeof affinity === "function" ? affinity : () => null;

      // Living set at the START of this evaluation. A victim killed earlier this
      // same evaluation is removed from `living` so it cannot also starve /
      // despair / be murdered twice within one day.
      const living: MortalAgentLike[] = agents.filter(
        (a) => isLiving(a) && this.isAlive(a!.name),
      ) as MortalAgentLike[];
      const dyingThisCall = new Set<string>();

      const recordDeath = (d: Death): void => {
        if (dyingThisCall.has(d.name)) return;
        dyingThisCall.add(d.name);
        this.dead.add(d.name);
        deaths.push(d);
      };

      // -- 1. MURDER (resolved first; a victim then can't starve/despair) -----
      // Each living killer A evaluates living, adjacent neighbours B and, if a
      // grudge at/below MURDER_GRUDGE exists, murders the MOST-negative such B
      // (tie-break by name). A killer that is itself murdered earlier this call
      // is removed from the killer pool (no posthumous murders).
      for (const a of living) {
        const aName = a.name as string;
        if (dyingThisCall.has(aName)) continue; // A already died this call
        let victim: string | null = null;
        let worst = MURDER_GRUDGE; // must be <= grudge floor to qualify
        for (const b of living) {
          const bName = b.name as string;
          if (bName === aName) continue;
          if (dyingThisCall.has(bName)) continue; // B already dead this call
          if (chebyshev(a.pos, b.pos) > 1) continue; // not adjacent
          let aff: number | null;
          try {
            aff = safeAffinity(aName, bName);
          } catch {
            aff = null;
          }
          if (aff === null || typeof aff !== "number") continue;
          if (aff > MURDER_GRUDGE) continue; // not a strong enough grudge
          // most-negative grudge wins; tie-break by victim name (deterministic).
          if (aff < worst || (aff === worst && victim !== null && bName < victim)) {
            worst = aff;
            victim = bName;
          } else if (victim === null) {
            worst = aff;
            victim = bName;
          }
        }
        if (victim !== null) {
          recordDeath({ name: victim, cause: "murder", by: aName });
        }
      }

      // -- 2. STARVATION + DESPAIR (counters; victims of murder excluded) -----
      for (const a of living) {
        const name = a.name as string;
        if (dyingThisCall.has(name)) {
          // Murdered this call — clear any crisis bookkeeping and skip.
          this.starveCount.delete(name);
          this.despairCount.delete(name);
          continue;
        }
        const energy =
          typeof a.energy === "number" ? a.energy : ENERGY_START;
        const gold = typeof a.gold === "number" ? a.gold : 0;

        // STARVATION counter: increments while pinned low, resets otherwise.
        if (energy <= STARVE_ENERGY) {
          const c = (this.starveCount.get(name) ?? 0) + 1;
          this.starveCount.set(name, c);
          if (c >= STARVE_DAYS) {
            recordDeath({ name, cause: "starvation" });
            this.starveCount.delete(name);
            this.despairCount.delete(name);
            continue;
          }
        } else {
          this.starveCount.delete(name); // a good night's sleep resets it
        }

        // DESPAIR counter: ALL gates must hold this day or it resets.
        const crisisNeeds = this.crisisNeedCount(a.needs);
        const tie = this.strongestTie(name, living, safeAffinity);
        const lowEnergy = energy <= DESPAIR_ENERGY;
        const lowGold = gold < DESPAIR_MAX_GOLD;
        const crisis = crisisNeeds >= DESPAIR_MIN_CRISIS_NEEDS;
        // "low/negative social ties": no positive tie at all (null) OR the
        // strongest tie is non-positive (<= DESPAIR_MAX_AFFINITY).
        const isolated = tie === null || tie <= DESPAIR_MAX_AFFINITY;

        if (lowEnergy && lowGold && crisis && isolated) {
          const c = (this.despairCount.get(name) ?? 0) + 1;
          this.despairCount.set(name, c);
          if (c >= DESPAIR_DAYS) {
            recordDeath({ name, cause: "despair" });
            this.despairCount.delete(name);
            this.starveCount.delete(name);
            continue;
          }
        } else {
          this.despairCount.delete(name); // any relief resets the despair clock
        }
      }

      // Deterministic ordering, independent of agent-array order.
      deaths.sort((x, y) => x.name.localeCompare(y.name));
    } catch {
      /* defensive — mortality must never throw into the day-advance loop */
    }
    return deaths;
  }
}
