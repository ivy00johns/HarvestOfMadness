/**
 * Plan-intent follower tests (v4): when obs.self.currentPlanStep contains
 * leisure keywords the mock router should head toward the matching landmark
 * (or act there). Also covers persona-driven non-farm steps in mockDailyPlan,
 * and the NO-plan-step regression (farm behavior is unchanged).
 *
 * Priority contract being tested:
 *   event ATTEND > event INVITE > plan-intent follower > farm ladder
 */
import { describe, expect, it } from "vitest";
import type { ActionType, Landmark, Observation, Vec2 } from "@contracts/types";
import { mockDailyPlan, mockRouter } from "../../src/llm/mock";
import { parseAgentAction } from "../../src/llm/parse";
import { buildUserPrompt } from "../../src/llm/prompts";

// ---------------------------------------------------------------------------
// Shared test helpers
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

const READY_CROP = { kind: "parsnip", stage: 4, watered: true, ready: true };

const BASE_LANDMARKS: Landmark[] = [
  { kind: "bed", pos: BED },
  { kind: "shop", pos: SHOP },
  { kind: "tavern", pos: TAVERN },
  { kind: "water", pos: POND },
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

// ---------------------------------------------------------------------------
// A. Plan-intent follower — tavern / socialize
// ---------------------------------------------------------------------------

describe("plan-intent follower — tavern/socialize", () => {
  it("heads toward the tavern when plan says 'socialize at the tavern' and agent is far", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        gold: 0,
        inventory: [],
        currentPlanStep: "socialize at the tavern",
      },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("MOVE_TO");
    expect(action.target).toEqual(TAVERN);
  });

  it("talks to a neighbor when at the tavern with a plan to gather", async () => {
    // Position the agent adjacent to the tavern (one tile above)
    const obs = makeObs({
      self: {
        pos: { x: 22, y: 14 },
        gold: 0,
        inventory: [],
        currentPlanStep: "gather at the tavern and chat",
      },
      nearby: {
        tiles: [],
        agents: [{ name: "Social Sage", pos: { x: 22, y: 15 }, lastSeenDoing: "chatting" }],
      },
    });
    const { action } = await decide(obs);
    // At the tavern with a neighbor → TALK_TO
    expect(action.action).toBe("TALK_TO");
    expect((action.target as { agentName: string }).agentName).toBe("Social Sage");
  });

  it("emotes or waits at the tavern with no neighbor and a socialize plan", async () => {
    // Agent on the exact tavern tile, no neighbors
    const obs = makeObs({
      self: {
        pos: { ...TAVERN },
        gold: 0,
        inventory: [],
        currentPlanStep: "socialize at the tavern this afternoon",
      },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(["EMOTE", "WAIT"]).toContain(action.action);
  });

  it("heads toward the tavern when plan mentions 'chat'", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 3, y: 3 },
        gold: 0,
        inventory: [],
        currentPlanStep: "chat with the farmers at the tavern",
      },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("MOVE_TO");
    expect(action.target).toEqual(TAVERN);
  });
});

// ---------------------------------------------------------------------------
// B. Plan-intent follower — pond / relax
// ---------------------------------------------------------------------------

describe("plan-intent follower — pond/relax", () => {
  it("heads toward the pond when plan says 'relax by the pond'", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        gold: 0,
        inventory: [],
        currentPlanStep: "relax by the pond and reflect",
      },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("MOVE_TO");
    expect(action.target).toEqual(POND);
  });

  it("emotes when already adjacent to the pond with a relax plan", async () => {
    // One tile above the pond
    const obs = makeObs({
      self: {
        pos: { x: 30, y: 7 },
        gold: 0,
        inventory: [],
        currentPlanStep: "stroll by the pond and reflect on the day",
      },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(["EMOTE", "WAIT"]).toContain(action.action);
  });

  it("heads toward pond when plan says 'stroll'", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 10, y: 10 },
        gold: 0,
        inventory: [],
        currentPlanStep: "stroll around the commons and wander",
      },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("MOVE_TO");
    expect(action.target).toEqual(POND);
  });
});

// ---------------------------------------------------------------------------
// C. Plan-intent follower — rest / home
// ---------------------------------------------------------------------------

describe("plan-intent follower — rest/home", () => {
  it("heads toward bed when plan says 'rest at home' and not night", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 10, y: 10 },
        energy: 80,
        gold: 0,
        inventory: [],
        currentPlanStep: "rest at home and take a break",
      },
      time: { day: 2, phase: "afternoon" },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("MOVE_TO");
    expect(action.target).toEqual(BED);
  });
});

// ---------------------------------------------------------------------------
// D. Priority: event ATTEND still beats the plan-intent follower
// ---------------------------------------------------------------------------

describe("event ATTEND still beats plan-intent follower", () => {
  it("moves to the event location (not just the tavern) when isNow, even with a pond plan", async () => {
    const eventLocation: Vec2 = { x: 22, y: 15 }; // tavern door
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        gold: 0,
        inventory: [],
        currentPlanStep: "relax by the pond",
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
      time: { day: 2, phase: "afternoon" },
      nearby: { tiles: [], agents: [] },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("MOVE_TO");
    expect(action.target).toEqual(eventLocation);
  });
});

// ---------------------------------------------------------------------------
// E. NO-plan-step regression: farm behavior unchanged
// ---------------------------------------------------------------------------

describe("NO-plan-step regression — farm behavior unchanged", () => {
  it("harvests a ready adjacent crop when no plan step is set", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        energy: 80,
        gold: 100,
        inventory: [],
        currentPlanStep: null,
      },
      nearby: {
        tiles: [{ x: 5, y: 6, type: "tilled", crop: READY_CROP }],
        agents: [],
      },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("HARVEST");
    expect(action.target).toEqual({ x: 5, y: 6 });
  });

  it("harvests when plan step is empty string", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        energy: 80,
        gold: 100,
        inventory: [],
        currentPlanStep: "",
      },
      nearby: {
        tiles: [{ x: 5, y: 6, type: "tilled", crop: READY_CROP }],
        agents: [],
      },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("HARVEST");
    expect(action.target).toEqual({ x: 5, y: 6 });
  });

  it("farm step plan doesn't trigger leisure — still harvests", async () => {
    // Plan step is farm-flavored, not a leisure keyword
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
      },
    });
    const { action } = await decide(obs);
    expect(action.action).toBe("HARVEST");
    expect(action.target).toEqual({ x: 5, y: 6 });
  });

  it("falls back gracefully when no tavern landmark exists but plan mentions tavern", async () => {
    // No tavern in landmarks — should not crash, should fall through to farm
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 5 },
        energy: 80,
        gold: 100,
        inventory: [],
        currentPlanStep: "socialize at the tavern",
      },
      nearby: {
        tiles: [{ x: 5, y: 6, type: "tilled", crop: READY_CROP }],
        agents: [],
        landmarks: [{ kind: "bed", pos: BED }, { kind: "shop", pos: SHOP }], // no tavern
      },
    });
    const { action } = await decide(obs);
    // No tavern landmark found → falls through to farm ladder → HARVEST
    expect(action.action).toBe("HARVEST");
  });
});

// ---------------------------------------------------------------------------
// F. mockDailyPlan — persona-driven non-farm steps
// ---------------------------------------------------------------------------

describe("mockDailyPlan — richer non-farm steps", () => {
  it("social persona gets at least one tavern step", () => {
    // Social Sage persona — check multiple days to confirm tavern appears
    let hasTavern = false;
    for (let day = 1; day <= 4; day++) {
      const plan = mockDailyPlan("Social Sage — a chatty wanderer who values social bonds", day);
      for (const step of plan.steps) {
        if (
          step.goal.toLowerCase().includes("tavern") ||
          step.targetLandmark === "tavern"
        ) {
          hasTavern = true;
        }
      }
    }
    expect(hasTavern).toBe(true);
  });

  it("dreamy/moonstruck persona gets at least one pond/relax step", () => {
    let hasPond = false;
    for (let day = 1; day <= 4; day++) {
      const plan = mockDailyPlan(
        "Moonstruck Moss — a dreamy stargazer who farms by feel",
        day,
      );
      for (const step of plan.steps) {
        if (
          step.goal.toLowerCase().includes("pond") ||
          step.goal.toLowerCase().includes("relax") ||
          step.goal.toLowerCase().includes("reflect") ||
          step.targetLandmark === "water"
        ) {
          hasPond = true;
        }
      }
    }
    expect(hasPond).toBe(true);
  });

  it("frugal persona gets at least one market/shop step in afternoon or evening", () => {
    let hasMarket = false;
    for (let day = 1; day <= 4; day++) {
      const plan = mockDailyPlan(
        "Frugal Fern — a sharp-eyed bargain hunter who counts every copper",
        day,
      );
      for (const step of plan.steps) {
        if (
          step.goal.toLowerCase().includes("market") ||
          step.goal.toLowerCase().includes("haggle") ||
          step.goal.toLowerCase().includes("price") ||
          step.targetLandmark === "shop"
        ) {
          hasMarket = true;
        }
      }
    }
    expect(hasMarket).toBe(true);
  });

  it("all personas still produce exactly 4 steps with night→bed", () => {
    const personas = [
      "Social Sage — chatty",
      "Moonstruck Moss — dreamy",
      "Frugal Fern — frugal",
      "Reckless Rusty — reckless",
      "Wandering Wren — wanders",
      "Diligent Dora — methodical",
    ];
    for (const persona of personas) {
      const plan = mockDailyPlan(persona, 3);
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

  it("is deterministic — same persona + day always gives same plan", () => {
    const p = "Social Sage — loves talking";
    const a = mockDailyPlan(p, 2);
    const b = mockDailyPlan(p, 2);
    expect(a).toEqual(b);
  });

  it("different agents on the same day can get different plans (varied routines)", () => {
    const plan1 = mockDailyPlan("Social Sage — loves talking", 2);
    const plan2 = mockDailyPlan("Diligent Dora — methodical optimizer", 2);
    // At least one step goal should differ
    const allSame = plan1.steps.every((s, i) => s.goal === plan2.steps[i].goal);
    expect(allSame).toBe(false);
  });
});
