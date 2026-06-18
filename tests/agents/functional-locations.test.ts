/**
 * Functional Locations — Wave 5b proof.
 *
 * Agents purposefully visit the building tied to their role+goal:
 *   merchant→store/shop, socialite→cafe, banker→office, wanderer→park.
 *
 * This suite covers three layers:
 *   1. The pure mapping module (src/agents/locations.ts): role defaults,
 *      farmer→null, goal-beats-role, keyword extraction, determinism.
 *   2. mockDailyPlan role conditioning + the FROZEN byte-identity guard
 *      (2-arg ≡ (…,undefined,"farmer") ≡ (…,undefined,undefined)) + still
 *      4 steps / phase order / night→bed + tavern-never-via-role.
 *   3. Decision routing through mockRouter + buildUserPrompt: MOVE_TO when far,
 *      adjacent EMOTE/WAIT/TALK_TO; the filter-admission proof; the no-keyword
 *      farmer regression; determinism; graceful fallback when the landmark is
 *      absent; and event-ATTEND beating a cafe step.
 *
 * DISPERSIVE invariant: each role routes to a DIFFERENT building, NEVER the
 * tavern, and the cafe TALK_TO fires only for an ALREADY-ADJACENT neighbor — so
 * the party kill-switch (party-emergence.test) stays meaningful.
 */
import { describe, expect, it } from "vitest";
import type { ActionType, Landmark, Observation, Vec2 } from "@contracts/types";
import { ROLE_VOCABULARY } from "@contracts/types";
import {
  FUNCTIONAL_STEP_TEXT,
  ROLE_LOCATION,
  goalLocation,
  preferredLocation,
} from "../../src/agents/locations";
import { mockDailyPlan, mockRouter } from "../../src/llm/mock";
import { parseAgentAction } from "../../src/llm/parse";
import { buildUserPrompt } from "../../src/llm/prompts";

// ---------------------------------------------------------------------------
// Shared test helpers (mirrors mock-daily.test.ts)
// ---------------------------------------------------------------------------

const ALL_ACTIONS: ActionType[] = [
  "MOVE_TO",
  "TILL",
  "PLANT",
  "WATER",
  "HARVEST",
  "BUY",
  "SELL",
  "TALK_TO",
  "EMOTE",
  "SLEEP",
  "WAIT",
  "USE_OBJECT",
];

const BED: Vec2 = { x: 2, y: 2 };
const SHOP: Vec2 = { x: 10, y: 5 };
const TAVERN: Vec2 = { x: 22, y: 15 };
const POND: Vec2 = { x: 30, y: 8 };
const CAFE: Vec2 = { x: 41, y: 18 };
const OFFICE: Vec2 = { x: 24, y: 21 };
const PARK: Vec2 = { x: 50, y: 30 };

const READY_CROP = { kind: "parsnip", stage: 4, watered: true, ready: true };

const BASE_LANDMARKS: Landmark[] = [
  { kind: "bed", pos: BED },
  { kind: "shop", pos: SHOP },
  { kind: "tavern", pos: TAVERN },
  { kind: "water", pos: POND },
  { kind: "cafe", pos: CAFE },
  { kind: "office", pos: OFFICE },
  { kind: "park", pos: PARK },
];

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function makeObs(overrides: DeepPartial<Observation> = {}): Observation {
  const base: Observation = {
    self: {
      name: "Dora",
      persona: "Diligent Dora — methodical optimizer",
      role: "farmer",
      pos: { x: 5, y: 5 },
      energy: 80,
      gold: 100,
      inventory: [],
      goal: null,
    },
    time: { day: 2, phase: "afternoon" },
    nearby: {
      tiles: [],
      agents: [],
      landmarks: BASE_LANDMARKS,
    },
    lastAction: null,
    availableActions: [...ALL_ACTIONS],
    economy: { sells: { "crop:parsnip": 35 }, buys: { "seed:parsnip": 20 } },
  };
  return {
    ...base,
    ...overrides,
    self: { ...base.self, ...(overrides.self as object) },
    time: { ...base.time, ...(overrides.time as object) },
    nearby: { ...base.nearby, ...(overrides.nearby as object) },
  } as Observation;
}

async function decide(obs: Observation) {
  const res = await mockRouter({
    agentId: obs.self.name,
    system: "test",
    user: buildUserPrompt(obs),
  });
  const action = parseAgentAction(res.raw)!;
  return { res, action };
}

// ===========================================================================
// 1. Pure mapping — locations.ts
// ===========================================================================

describe("locations — pure mapping", () => {
  it("ROLE_LOCATION is total over ROLE_VOCABULARY with farmer→null and a DISTINCT non-tavern building per role", () => {
    // Total mapping (one entry per role in the vocabulary).
    for (const role of ROLE_VOCABULARY) {
      expect(ROLE_LOCATION).toHaveProperty(role);
    }
    expect(Object.keys(ROLE_LOCATION).sort()).toEqual([...ROLE_VOCABULARY].sort());

    // farmer is the default / byte-identical no-op path.
    expect(ROLE_LOCATION.farmer).toBeNull();
    expect(ROLE_LOCATION.merchant).toBe("shop");
    expect(ROLE_LOCATION.socialite).toBe("cafe");
    expect(ROLE_LOCATION.banker).toBe("office");
    expect(ROLE_LOCATION.wanderer).toBe("park");

    // DISPERSIVE: non-null targets are all distinct and NONE is the tavern.
    const targets = Object.values(ROLE_LOCATION).filter((v): v is NonNullable<typeof v> => v !== null);
    expect(new Set(targets).size).toBe(targets.length); // all distinct
    expect(targets).not.toContain("tavern");
  });

  it("goalLocation extracts cafe/office/park/school keywords (first match), null otherwise", () => {
    expect(goalLocation("grab a coffee and catch up")).toBe("cafe");
    expect(goalLocation("meet a colleague at the cafe")).toBe("cafe");
    expect(goalLocation("work at the office on the ledger")).toBe("office");
    expect(goalLocation("finish the paperwork")).toBe("office");
    expect(goalLocation("study the lesson for school")).toBe("school");
    expect(goalLocation("take some fresh air in the park")).toBe("park");
    expect(goalLocation("get some fresh air")).toBe("park");
    // No functional keyword → null (so the role default applies).
    expect(goalLocation("water the crops on the east plot")).toBeNull();
    expect(goalLocation("")).toBeNull();
    expect(goalLocation(null)).toBeNull();
    expect(goalLocation(undefined)).toBeNull();
  });

  it("preferredLocation: role default with no goal hit; farmer+no-goal → null", () => {
    expect(preferredLocation("merchant", null)).toBe("shop");
    expect(preferredLocation("socialite", null)).toBe("cafe");
    expect(preferredLocation("banker", null)).toBe("office");
    expect(preferredLocation("wanderer", null)).toBe("park");
    expect(preferredLocation("farmer", null)).toBeNull();
    expect(preferredLocation("farmer", "water the crops")).toBeNull();
    // Unknown / malformed role → null (defensive, no throw).
    expect(preferredLocation("knight", null)).toBeNull();
    expect(preferredLocation(null, null)).toBeNull();
    expect(preferredLocation(undefined, "water the crops")).toBeNull();
  });

  it("preferredLocation: goal keyword WINS over the role default", () => {
    // A merchant whose goal is to relax in the park → park, not shop.
    expect(preferredLocation("merchant", "take some fresh air in the park")).toBe("park");
    // A banker who wants coffee → cafe, not office.
    expect(preferredLocation("banker", "grab a coffee with a colleague")).toBe("cafe");
    // Even a farmer goes where the goal points.
    expect(preferredLocation("farmer", "work at the office today")).toBe("office");
  });

  it("preferredLocation is deterministic (pure — same inputs, same output)", () => {
    for (const role of ROLE_VOCABULARY) {
      const a = preferredLocation(role, "a plain day of nothing special");
      const b = preferredLocation(role, "a plain day of nothing special");
      expect(a).toBe(b);
    }
    expect(preferredLocation("socialite", null)).toBe(preferredLocation("socialite", null));
  });

  it("FUNCTIONAL_STEP_TEXT has afternoon/evening text for every functional kind, each embedding its routing keyword", () => {
    // The routing keyword each branch matches on must appear in the step text.
    const keyword: Record<string, string> = {
      shop: "market", // routed via the existing market branch
      cafe: "cafe",
      office: "office",
      park: "park",
      tavern: "tavern",
      school: "school",
    };
    for (const [kind, txt] of Object.entries(FUNCTIONAL_STEP_TEXT)) {
      expect(txt.afternoon.length).toBeGreaterThan(0);
      expect(txt.evening.length).toBeGreaterThan(0);
      expect(txt.afternoon.toLowerCase()).toContain(keyword[kind]);
      expect(txt.evening.toLowerCase()).toContain(keyword[kind]);
    }
    // Afternoon labels stay legible (≤ 40 chars for the activity-label clip)
    // for the four LIVE functional kinds (tavern/school are dormant).
    for (const kind of ["shop", "cafe", "office", "park"] as const) {
      expect(FUNCTIONAL_STEP_TEXT[kind].afternoon.length).toBeLessThanOrEqual(40);
    }
  });
});

// ===========================================================================
// 2. mockDailyPlan — role conditioning + FROZEN byte-identity guard
// ===========================================================================

describe("mockDailyPlan — role conditioning", () => {
  const PERSONA = "Plain Pat — an ordinary farmer";

  it("merchant routes the afternoon+evening to the shop/store", () => {
    const plan = mockDailyPlan(PERSONA, 2, undefined, "merchant");
    const afternoon = plan.steps.find((s) => s.phase === "afternoon")!;
    const evening = plan.steps.find((s) => s.phase === "evening")!;
    expect(afternoon.targetLandmark).toBe("shop");
    expect(evening.targetLandmark).toBe("shop");
    expect(afternoon.goal.toLowerCase()).toContain("store");
  });

  it("socialite routes the afternoon+evening to the cafe", () => {
    const plan = mockDailyPlan(PERSONA, 2, undefined, "socialite");
    const afternoon = plan.steps.find((s) => s.phase === "afternoon")!;
    const evening = plan.steps.find((s) => s.phase === "evening")!;
    expect(afternoon.targetLandmark).toBe("cafe");
    expect(evening.targetLandmark).toBe("cafe");
    expect(afternoon.goal.toLowerCase()).toContain("cafe");
  });

  it("banker routes the afternoon+evening to the office", () => {
    const plan = mockDailyPlan(PERSONA, 2, undefined, "banker");
    const afternoon = plan.steps.find((s) => s.phase === "afternoon")!;
    const evening = plan.steps.find((s) => s.phase === "evening")!;
    expect(afternoon.targetLandmark).toBe("office");
    expect(evening.targetLandmark).toBe("office");
    expect(afternoon.goal.toLowerCase()).toContain("office");
  });

  it("wanderer routes the afternoon+evening to the park", () => {
    const plan = mockDailyPlan(PERSONA, 2, undefined, "wanderer");
    const afternoon = plan.steps.find((s) => s.phase === "afternoon")!;
    const evening = plan.steps.find((s) => s.phase === "evening")!;
    expect(afternoon.targetLandmark).toBe("park");
    expect(evening.targetLandmark).toBe("park");
    expect(afternoon.goal.toLowerCase()).toContain("park");
  });

  it("the goal keyword WINS over the role (a wanderer told to go to the cafe goes to the cafe)", () => {
    const plan = mockDailyPlan(PERSONA, 2, "grab a coffee at the cafe", "wanderer");
    const afternoon = plan.steps.find((s) => s.phase === "afternoon")!;
    expect(afternoon.targetLandmark).toBe("cafe");
  });

  it("a goal the goal-block already claims (market) is NOT overwritten by the merchant role block", () => {
    // "sell" matches the existing Wave-3 goal block → shop with the market text.
    // The role block must NOT clobber it (goalConditioned guard).
    const plan = mockDailyPlan(PERSONA, 2, "sell my harvest at the market", "merchant");
    const afternoon = plan.steps.find((s) => s.phase === "afternoon")!;
    expect(afternoon.targetLandmark).toBe("shop");
    // The Wave-3 goal-block text ("browse the market…"), not the role-block store text.
    expect(afternoon.goal).toContain("browse the market");
  });

  it("FROZEN byte-identity: (p,d) deep-equals (p,d,undefined,'farmer') deep-equals (p,d,undefined,undefined)", () => {
    const personas = [
      "Social Sage — chatty",
      "Moonstruck Moss — dreamy",
      "Frugal Fern — frugal",
      "Reckless Rusty — reckless",
      "Wandering Wren — wanders",
      "Diligent Dora — methodical",
    ];
    for (const persona of personas) {
      for (let day = 1; day <= 6; day++) {
        const twoArg = mockDailyPlan(persona, day);
        const farmerRole = mockDailyPlan(persona, day, undefined, "farmer");
        const undefRole = mockDailyPlan(persona, day, undefined, undefined);
        expect(farmerRole).toEqual(twoArg);
        expect(undefRole).toEqual(twoArg);
        // rawText must be byte-identical too (it feeds the inspector verbatim).
        expect(farmerRole.rawText).toBe(twoArg.rawText);
        expect(undefRole.rawText).toBe(twoArg.rawText);
      }
    }
  });

  it("all role variants still produce exactly 4 steps in phase order with night→bed", () => {
    for (const role of [...ROLE_VOCABULARY, undefined]) {
      const plan = mockDailyPlan("Plain Pat — ordinary", 3, undefined, role);
      expect(plan.steps).toHaveLength(4);
      expect(plan.steps.map((s) => s.phase)).toEqual([
        "morning",
        "afternoon",
        "evening",
        "night",
      ]);
      expect(plan.steps[3].targetLandmark).toBe("bed");
      expect(plan.steps.every((s) => s.goal.length > 0)).toBe(true);
    }
  });

  it("the morning step is never role-conditioned (stays farm-ish) for any role", () => {
    for (const role of ROLE_VOCABULARY) {
      const plan = mockDailyPlan("Plain Pat — ordinary", 3, undefined, role);
      const morning = plan.steps.find((s) => s.phase === "morning")!;
      // morning never carries a functional targetLandmark from the role block.
      expect(morning.targetLandmark).toBeUndefined();
    }
  });

  it("the role block NEVER routes to the tavern across roles and days 1..6", () => {
    for (const role of ROLE_VOCABULARY) {
      for (let day = 1; day <= 6; day++) {
        // Use a NON-social persona so the persona/varietySeed branches do not
        // themselves pick the tavern — isolating the role block's behavior.
        const plan = mockDailyPlan("Plain Pat — ordinary", day, undefined, role);
        for (const step of plan.steps) {
          expect(step.targetLandmark).not.toBe("tavern");
          expect(step.goal.toLowerCase()).not.toContain("tavern");
        }
      }
    }
  });

  it("is deterministic for a given (persona, day, goal, role)", () => {
    const a = mockDailyPlan("Plain Pat", 4, undefined, "banker");
    const b = mockDailyPlan("Plain Pat", 4, undefined, "banker");
    expect(a).toEqual(b);
  });
});

// ===========================================================================
// 3. Decision routing — mockRouter + buildUserPrompt
// ===========================================================================

describe("functional routing — cafe (socialite)", () => {
  it("MOVE_TO the cafe when far and the plan step says coffee at the cafe", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        gold: 0,
        inventory: [],
        currentPlanStep: FUNCTIONAL_STEP_TEXT.cafe.afternoon,
      },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("MOVE_TO");
    expect(action.target).toEqual(CAFE);
  });

  it("TALK_TO an ALREADY-ADJACENT neighbor when at the cafe (no move-to-converge)", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 41, y: 17 }, // one tile above the cafe door
        gold: 0,
        inventory: [],
        currentPlanStep: FUNCTIONAL_STEP_TEXT.cafe.afternoon,
      },
      nearby: {
        tiles: [],
        agents: [{ name: "Social Sage", pos: { x: 41, y: 18 }, lastSeenDoing: "chatting" }],
      },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("TALK_TO");
    expect((action.target as { agentName: string }).agentName).toBe("Social Sage");
  });

  it("EMOTE or WAIT at the cafe with NO neighbor (dispersive)", async () => {
    const obs = makeObs({
      self: {
        pos: { ...CAFE },
        gold: 0,
        inventory: [],
        currentPlanStep: FUNCTIONAL_STEP_TEXT.cafe.evening,
      },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(["EMOTE", "WAIT"]).toContain(action.action);
  });
});

describe("functional routing — office (banker) & park (wanderer)", () => {
  it("MOVE_TO the office when far with an office plan step", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        gold: 0,
        inventory: [],
        currentPlanStep: FUNCTIONAL_STEP_TEXT.office.afternoon,
      },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("MOVE_TO");
    expect(action.target).toEqual(OFFICE);
  });

  it("EMOTE or WAIT at the office (never TALK_TO — dispersive), even with a neighbor adjacent", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 24, y: 20 }, // one tile above the office door
        gold: 0,
        inventory: [],
        currentPlanStep: FUNCTIONAL_STEP_TEXT.office.evening,
      },
      nearby: {
        tiles: [],
        agents: [{ name: "Banker Bob", pos: { x: 24, y: 21 }, lastSeenDoing: "tallying" }],
      },
    });
    const { action } = await decide(obs);
    expect(["EMOTE", "WAIT"]).toContain(action.action);
  });

  it("MOVE_TO the park when far with a park plan step", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        gold: 0,
        inventory: [],
        currentPlanStep: FUNCTIONAL_STEP_TEXT.park.afternoon,
      },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("MOVE_TO");
    expect(action.target).toEqual(PARK);
  });

  it("EMOTE or WAIT at the park (dispersive)", async () => {
    const obs = makeObs({
      self: {
        pos: { ...PARK },
        gold: 0,
        inventory: [],
        currentPlanStep: FUNCTIONAL_STEP_TEXT.park.evening,
      },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(["EMOTE", "WAIT"]).toContain(action.action);
  });
});

describe("functional routing — filter admission + regressions", () => {
  it("FILTER-ADMISSION proof: a cafe-only observation + cafe step routes there (would have fallen through pre-5b)", async () => {
    // ONLY a cafe landmark in view — before Wave 5b the normalizeObservation
    // filter dropped cafe, so this step had no landmark to route to and fell
    // through to the farm ladder. Admitting cafe makes the routing fire.
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        gold: 0,
        inventory: [],
        currentPlanStep: "coffee at the cafe",
      },
      nearby: {
        tiles: [],
        agents: [],
        landmarks: [{ kind: "cafe", pos: CAFE }],
      },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("MOVE_TO");
    expect(action.target).toEqual(CAFE);
  });

  it("NO-KEYWORD regression: a farmer with a harvest step + cafe landmark still HARVESTs", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        energy: 80,
        gold: 100,
        inventory: [],
        currentPlanStep: "harvest anything ready and keep the plots tended",
      },
      nearby: {
        tiles: [{ x: 5, y: 6, type: "tilled", crop: READY_CROP }],
        agents: [],
        landmarks: BASE_LANDMARKS, // cafe/office/park all present but inert
      },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("HARVEST");
    expect(action.target).toEqual({ x: 5, y: 6 });
  });

  it("graceful fallback: a cafe plan step with NO cafe landmark falls through to the farm ladder (no crash)", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        energy: 80,
        gold: 100,
        inventory: [],
        currentPlanStep: "coffee at the cafe",
      },
      nearby: {
        tiles: [{ x: 5, y: 6, type: "tilled", crop: READY_CROP }],
        agents: [],
        landmarks: [{ kind: "bed", pos: BED }, { kind: "shop", pos: SHOP }], // no cafe
      },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("HARVEST"); // farm ladder still runs
  });

  it("decision routing is deterministic — same obs → same action", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        gold: 0,
        inventory: [],
        currentPlanStep: "working at the office on the ledgers",
      },
      nearby: { tiles: [], agents: [] },
    });
    const a = await decide(obs);
    const b = await decide(obs);
    expect(a.res.raw).toBe(b.res.raw);
  });

  it("priority: an event HAPPENING NOW beats a cafe plan step", async () => {
    const eventLocation: Vec2 = { ...TAVERN };
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        gold: 0,
        inventory: [],
        currentPlanStep: "coffee at the cafe",
        knownEvents: [
          {
            id: "evt-1",
            host: "Social Sage",
            location: eventLocation,
            day: 2,
            phase: "afternoon",
            description: "a gathering at the tavern",
            isNow: true,
          },
        ],
      },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    // The event ATTEND branch (placed before the functional branches) wins.
    expect(action.action).toBe("MOVE_TO");
    expect(action.target).toEqual(eventLocation);
  });
});
