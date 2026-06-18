/**
 * Functional Locations (Wave 5b) — pure, deterministic mapping from an agent's
 * derived role (+ standing goal) to the civic building it should purposefully
 * visit, plus the Smallville-legible step text the mock planner stamps for that
 * building.
 *
 * This module is PURE: no Math.random, no Date.now, no I/O. It imports ONLY
 * @contracts/types so it can be shared by the planner, the mock router, and the
 * cognition wiring with no import cycle (agents → contracts only).
 *
 * Design invariants (functional-locations-design §1):
 *  - DISPERSIVE: each role routes to a DIFFERENT building and NEVER the tavern,
 *    so the party kill-switch stays meaningful (only a seeded event pulls the
 *    whole town to the tavern).
 *  - farmer (the default / fallback / below-sample role) maps to null, which is
 *    the BYTE-IDENTICAL no-op path through mockDailyPlan.
 *  - The goal keyword wins over the role default (a wandering merchant who has
 *    decided to relax at the park goes to the park).
 *  - "tavern" and "school" entries exist for completeness / forward-compat but
 *    are NEVER reached by the role/goal v1 path: no role maps to either, and the
 *    only goal keyword that selects "school" ("study"/"lesson"/…) is emitted by
 *    no mock plan or goal synthesizer.
 */
import type { DerivedRole, Landmark } from "@contracts/types";

/**
 * The subset of Landmark kinds that are "functional" destinations an agent can
 * be routed to by role/goal. (Excludes the purely environmental bed/water/house
 * kinds — those are handled by the existing rest/pond branches.)
 */
export type FunctionalKind = Extract<
  Landmark["kind"],
  "shop" | "cafe" | "office" | "park" | "tavern"
> | "school";

/**
 * Default building per derived role. farmer → null (the frozen byte-identical
 * path). Every non-farmer role routes to a DIFFERENT building and NONE route to
 * the tavern (kill-switch safety).
 */
export const ROLE_LOCATION: Record<DerivedRole, FunctionalKind | null> = {
  farmer: null, // default → byte-identical mockDailyPlan path
  merchant: "shop",
  socialite: "cafe",
  wanderer: "park",
  banker: "office",
};

/**
 * Goal-keyword → functional building (first match wins). We deliberately do NOT
 * map market/sell/haggle/price here — mockDailyPlan's existing Wave-3 goal block
 * already routes those to the shop, and duplicating them would fight that path.
 * The cafe/office/park keywords are net-new; "study"/"lesson"/… selects the
 * dormant "school" entry (no mock emits these, so it stays forward-compat only).
 */
export function goalLocation(goal: string | null | undefined): FunctionalKind | null {
  const g = (goal ?? "").toLowerCase();
  if (g.length === 0) return null;
  if (g.includes("cafe") || g.includes("coffee") || g.includes("catch up") || g.includes("colleague")) {
    return "cafe";
  }
  if (g.includes("office") || g.includes("work at") || g.includes("ledger") || g.includes("paperwork")) {
    return "office";
  }
  if (g.includes("study") || g.includes("school") || g.includes("lesson") || g.includes("teach")) {
    return "school";
  }
  if (g.includes("park") || g.includes("green") || g.includes("fresh air")) {
    return "park";
  }
  return null;
}

/**
 * The building an agent should head to, given its role and standing goal. The
 * GOAL keyword wins over the role default; absent a goal hit it falls back to
 * the role default. farmer + no matching goal → null (frozen no-op path).
 *
 * PURE & deterministic: same (role, goal) → same result, always.
 */
export function preferredLocation(
  role: DerivedRole | string | null | undefined,
  goal: string | null | undefined,
): FunctionalKind | null {
  const fromGoal = goalLocation(goal);
  if (fromGoal) return fromGoal;
  if (typeof role !== "string") return null;
  if (!(role in ROLE_LOCATION)) return null;
  return ROLE_LOCATION[role as DerivedRole];
}

/**
 * Smallville-legible step text per functional building. The afternoon/evening
 * verbs read like a daily routine ("working at the office", "coffee at the
 * cafe") AND embed the routing keyword the mock decision ladder matches on
 * (cafe→"cafe", office→"office", park→"park", shop→"market", tavern→"tavern").
 * Afternoon texts are kept ≤ 40 chars where possible (the WorldScene activity
 * label clips at 40).
 */
export const FUNCTIONAL_STEP_TEXT: Record<
  FunctionalKind,
  { afternoon: string; evening: string }
> = {
  shop: {
    afternoon: "tend the store, work the market stall",
    evening: "close up the market stall and tally takings",
  },
  cafe: {
    // NB: avoid the tavern-branch keywords (tavern/sociali/chat/gather) so the
    // cafe step reaches the dedicated cafe branch via "cafe"/"coffee", never the
    // tavern branch (kill-switch safety).
    afternoon: "coffee at the cafe over a cup",
    evening: "linger at the cafe over coffee",
  },
  office: {
    afternoon: "working at the office on the ledgers",
    evening: "finish the paperwork at the office",
  },
  park: {
    // NB: avoid the pond-branch keywords (stroll/walk/wander/relax/reflect) so
    // the park step is not swallowed by the pond/relax branch — it must reach
    // the dedicated park branch via the "park" / "fresh air" keyword.
    afternoon: "fresh air out in the green park",
    evening: "an evening out in the green park",
  },
  // Dormant — never reached by the role/goal v1 path (kept for completeness so
  // the type is total; routing them would create a tavern convergence point).
  tavern: {
    afternoon: "socialize at the tavern with the others",
    evening: "gather at the tavern — share news and company",
  },
  // Forward-compat only — no role maps here, no mock goal emits "study".
  school: {
    afternoon: "study at the school and trade lessons",
    evening: "review the day's lessons at the school",
  },
};
