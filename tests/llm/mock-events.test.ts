/**
 * Build 2 unit tests — event-driven branches in mockRouter.
 *
 * Tests:
 *   - ATTEND: agent with isNow event far away → MOVE_TO event location
 *   - ATTEND-arrived: agent already adjacent to event → EMOTE or WAIT (not MOVE_TO away)
 *   - HOST INVITE (far): host with inviteTargets far away → MOVE_TO toward target
 *   - HOST INVITE (adjacent): host with inviteTargets adjacent → TALK_TO target
 *   - NO-EVENT regression: no knownEvents/inviteTargets → normal farm behavior (HARVEST)
 */
import { describe, expect, it } from "vitest";
import type { ActionType, Observation, SimEvent, Vec2 } from "@contracts/types";
import { mockRouter } from "../../src/llm/mock";
import { parseAgentAction } from "../../src/llm/parse";
import { buildUserPrompt } from "../../src/llm/prompts";

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

const READY_CROP = { kind: "parsnip", stage: 4, watered: true, ready: true };

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
    time: { day: 1, phase: "morning" },
    nearby: {
      tiles: [],
      agents: [],
      landmarks: [
        { kind: "bed", pos: BED },
        { kind: "shop", pos: SHOP },
      ],
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

async function decideFor(obs: Observation) {
  const res = await mockRouter({
    agentId: obs.self.name,
    system: "test",
    user: buildUserPrompt(obs),
  });
  return res;
}

/** Build a SimEvent & { isNow } for the party at the tavern */
function partyEvent(isNow: boolean): SimEvent & { isNow: boolean } {
  return {
    id: "party-d1",
    host: "Social Sage",
    location: { ...TAVERN },
    day: 1,
    phase: "evening",
    description: "a gathering at the tavern",
    isNow,
  };
}

describe("mockRouter — v3 event branches", () => {
  describe("ATTEND branch", () => {
    it("moves toward the event location when isNow and agent is far away", async () => {
      // Agent at (5,5), tavern at (22,15) — not adjacent
      const obs = makeObs({
        self: {
          pos: { x: 5, y: 5 },
          gold: 0,       // silence shop-run branch
          inventory: [],
          knownEvents: [partyEvent(true)],
        },
        time: { day: 1, phase: "evening" },
        nearby: { tiles: [], agents: [] },
      });
      const res = await decideFor(obs);
      expect(res.model).toBe("mock");
      const action = parseAgentAction(res.raw)!;
      expect(action.action).toBe("MOVE_TO");
      expect(action.target).toEqual(TAVERN);
    });

    it("emotes or waits (not MOVE_TO away) when already adjacent to event", async () => {
      // Agent at (22,14) — one tile north of tavern (Chebyshev = 1)
      const obs = makeObs({
        self: {
          pos: { x: 22, y: 14 },
          gold: 0,
          inventory: [],
          knownEvents: [partyEvent(true)],
        },
        time: { day: 1, phase: "evening" },
        nearby: { tiles: [], agents: [] },
      });
      const res = await decideFor(obs);
      const action = parseAgentAction(res.raw)!;
      // Must NOT move away from the event
      expect(action.action).not.toBe("MOVE_TO");
      // Should be EMOTE or WAIT
      expect(["EMOTE", "WAIT"]).toContain(action.action);
    });

    it("emotes or waits (not MOVE_TO) when on the exact event tile", async () => {
      const obs = makeObs({
        self: {
          pos: { ...TAVERN },
          gold: 0,
          inventory: [],
          knownEvents: [partyEvent(true)],
        },
        time: { day: 1, phase: "evening" },
        nearby: { tiles: [], agents: [] },
      });
      const res = await decideFor(obs);
      const action = parseAgentAction(res.raw)!;
      expect(action.action).not.toBe("MOVE_TO");
      expect(["EMOTE", "WAIT"]).toContain(action.action);
    });

    it("does NOT attend when isNow is false (future event)", async () => {
      // If the event is upcoming (not now), attend branch is skipped
      const obs = makeObs({
        self: {
          pos: { x: 5, y: 5 },
          gold: 0,
          inventory: [],
          knownEvents: [partyEvent(false)],
        },
        time: { day: 1, phase: "morning" },
        nearby: { tiles: [], agents: [] },
      });
      const res = await decideFor(obs);
      const action = parseAgentAction(res.raw)!;
      // Should NOT be heading to the tavern (isNow=false → skip attend branch)
      if (action.action === "MOVE_TO") {
        expect(action.target).not.toEqual(TAVERN);
      }
    });
  });

  describe("HOST INVITE branch", () => {
    it("moves toward the invite target when not adjacent", async () => {
      // Agent at (5,5), Gus at (30,20) — far away, no nowEvent
      const obs = makeObs({
        self: {
          pos: { x: 5, y: 5 },
          gold: 0,
          inventory: [],
          knownEvents: [partyEvent(false)],  // isNow=false so attend branch skips
          inviteTargets: [{ name: "Grumbling Gus", pos: { x: 30, y: 20 } }],
        },
        time: { day: 1, phase: "morning" },
        nearby: { tiles: [], agents: [] },
      });
      const res = await decideFor(obs);
      const action = parseAgentAction(res.raw)!;
      expect(action.action).toBe("MOVE_TO");
      expect(action.target).toEqual({ x: 30, y: 20 });
    });

    it("talks to the target when adjacent", async () => {
      // Agent at (5,5), Gus at (5,6) — adjacent (Chebyshev 1)
      const obs = makeObs({
        self: {
          pos: { x: 5, y: 5 },
          gold: 0,
          inventory: [],
          knownEvents: [partyEvent(false)],
          inviteTargets: [{ name: "Grumbling Gus", pos: { x: 5, y: 6 } }],
        },
        time: { day: 1, phase: "morning" },
        nearby: {
          tiles: [],
          agents: [{ name: "Grumbling Gus", pos: { x: 5, y: 6 }, lastSeenDoing: "tilling" }],
        },
      });
      const res = await decideFor(obs);
      const action = parseAgentAction(res.raw)!;
      expect(action.action).toBe("TALK_TO");
      expect(action.target).toEqual({ agentName: "Grumbling Gus" });
    });

    it("skips HOST INVITE when there is a nowEvent (ATTEND wins)", async () => {
      // Both nowEvent and inviteTargets — ATTEND should win
      const obs = makeObs({
        self: {
          pos: { x: 5, y: 5 },
          gold: 0,
          inventory: [],
          knownEvents: [partyEvent(true)],   // isNow = true
          inviteTargets: [{ name: "Grumbling Gus", pos: { x: 5, y: 6 } }],
        },
        time: { day: 1, phase: "evening" },
        nearby: { tiles: [], agents: [] },
      });
      const res = await decideFor(obs);
      const action = parseAgentAction(res.raw)!;
      // Should be heading to TAVERN (ATTEND), not TALK_TO Gus
      expect(action.action).toBe("MOVE_TO");
      expect(action.target).toEqual(TAVERN);
    });
  });

  describe("NO-EVENT regression", () => {
    it("harvests a ready adjacent crop when no events are present", async () => {
      // Normal farm behavior — no knownEvents, no inviteTargets
      const obs = makeObs({
        self: {
          pos: { x: 5, y: 5 },
          energy: 80,
          gold: 100,
          inventory: [],
        },
        nearby: {
          tiles: [{ x: 5, y: 6, type: "tilled", crop: READY_CROP }],
          agents: [],
        },
      });
      const res = await decideFor(obs);
      const action = parseAgentAction(res.raw)!;
      expect(action.action).toBe("HARVEST");
      expect(action.target).toEqual({ x: 5, y: 6 });
    });

    it("an obs with empty knownEvents array behaves like no events", async () => {
      const obs = makeObs({
        self: {
          pos: { x: 5, y: 5 },
          energy: 80,
          gold: 100,
          inventory: [],
          knownEvents: [],
        },
        nearby: {
          tiles: [{ x: 5, y: 6, type: "tilled", crop: READY_CROP }],
          agents: [],
        },
      });
      const res = await decideFor(obs);
      const action = parseAgentAction(res.raw)!;
      expect(action.action).toBe("HARVEST");
    });
  });

  describe("OPPORTUNISTIC SPREAD branch", () => {
    it("talks to an adjacent agent when the agent knows an event (not now)", async () => {
      // Agent knows a future event AND a neighbor is adjacent — should spread news
      const obs = makeObs({
        self: {
          pos: { x: 5, y: 5 },
          gold: 0,
          inventory: [],
          knownEvents: [partyEvent(false)],
        },
        time: { day: 1, phase: "morning" },
        nearby: {
          tiles: [],
          agents: [{ name: "Frugal Fern", pos: { x: 5, y: 6 }, lastSeenDoing: "tilling" }],
        },
      });
      const res = await decideFor(obs);
      const action = parseAgentAction(res.raw)!;
      expect(action.action).toBe("TALK_TO");
      expect(action.target).toEqual({ agentName: "Frugal Fern" });
    });

    it("does NOT spread when no events are known", async () => {
      // No knownEvents → opportunistic spread is skipped
      const obs = makeObs({
        self: { name: "Dora", persona: "Diligent Dora", gold: 0, inventory: [] },
        nearby: {
          tiles: [],
          agents: [{ name: "Frugal Fern", pos: { x: 5, y: 6 }, lastSeenDoing: "tilling" }],
        },
      });
      const res = await decideFor(obs);
      const action = parseAgentAction(res.raw)!;
      // Without event knowledge, should NOT TALK_TO for event-spread reasons
      // (only social persona chatting fires, and "Dora" persona doesn't include "social")
      expect(action.action).not.toBe("TALK_TO");
    });
  });
});
