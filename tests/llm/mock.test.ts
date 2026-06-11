import { describe, expect, it } from "vitest";
import type { ActionType, Observation, Vec2 } from "@contracts/types";
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
  "SLEEP",
  "WAIT",
];

const BED: Vec2 = { x: 2, y: 2 };
const SHOP: Vec2 = { x: 10, y: 5 };

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

describe("mockRouter — response shape", () => {
  it("returns model 'mock', latency 0-5, and raw that re-parses to the parsed action", async () => {
    const res = await decideFor(makeObs());
    expect(res.model).toBe("mock");
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.latencyMs).toBeLessThanOrEqual(5);
    expect(res.error).toBeUndefined();
    expect(res.parsed).toBeDefined();
    expect(parseAgentAction(res.raw)).toEqual(res.parsed);
  });

  it("is deterministic for identical observations", async () => {
    const obs = makeObs();
    const a = await decideFor(obs);
    const b = await decideFor(obs);
    expect(a).toEqual(b);
  });

  it("falls back to WAIT when the observation cannot be parsed", async () => {
    const res = await mockRouter({ agentId: "x", system: "s", user: "not json at all" });
    expect(res.parsed?.action).toBe("WAIT");
    expect(res.model).toBe("mock");
  });
});

describe("mockRouter — farm loop heuristics", () => {
  it("sleeps at night when adjacent to the bed", async () => {
    const res = await decideFor(
      makeObs({ time: { day: 2, phase: "night" }, self: { pos: { x: 2, y: 3 } } }),
    );
    expect(res.parsed?.action).toBe("SLEEP");
  });

  it("walks to bed at night when far from it", async () => {
    const res = await decideFor(makeObs({ time: { day: 2, phase: "night" } }));
    expect(res.parsed?.action).toBe("MOVE_TO");
    expect(res.parsed?.target).toEqual(BED);
  });

  it("retreats toward bed when exhausted", async () => {
    const res = await decideFor(makeObs({ self: { energy: 1 } }));
    expect(res.parsed?.action).toBe("MOVE_TO");
    expect(res.parsed?.target).toEqual(BED);
  });

  it("harvests an adjacent ready crop", async () => {
    const obs = makeObs({
      nearby: {
        tiles: [
          {
            x: 5,
            y: 6,
            type: "tilled",
            crop: { kind: "parsnip", stage: 4, watered: true, ready: true },
          },
        ],
      },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("HARVEST");
    expect(res.parsed?.target).toEqual({ x: 5, y: 6 });
  });

  it("moves toward a ready crop that is out of reach", async () => {
    const obs = makeObs({
      nearby: {
        tiles: [
          {
            x: 8,
            y: 8,
            type: "tilled",
            crop: { kind: "parsnip", stage: 4, watered: true, ready: true },
          },
        ],
      },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("MOVE_TO");
    expect(res.parsed?.target).toEqual({ x: 8, y: 8 });
  });

  it("waters an adjacent unwatered crop", async () => {
    const obs = makeObs({
      nearby: {
        tiles: [
          {
            x: 4,
            y: 5,
            type: "tilled",
            crop: { kind: "parsnip", stage: 1, watered: false, ready: false },
          },
        ],
      },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("WATER");
    expect(res.parsed?.target).toEqual({ x: 4, y: 5 });
  });

  it("plants on an adjacent empty tilled tile when holding seeds", async () => {
    const obs = makeObs({
      self: { inventory: [{ itemId: "seed:parsnip", qty: 3 }] },
      nearby: { tiles: [{ x: 5, y: 4, type: "tilled" }] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("PLANT");
    expect(res.parsed?.target).toEqual({ x: 5, y: 4 });
  });

  it("tills adjacent soil when few plots exist", async () => {
    const obs = makeObs({ nearby: { tiles: [{ x: 6, y: 5, type: "soil" }] } });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("TILL");
    expect(res.parsed?.target).toEqual({ x: 6, y: 5 });
  });

  it("sells the harvest at the shop", async () => {
    const obs = makeObs({
      self: { pos: { x: 10, y: 6 }, inventory: [{ itemId: "crop:parsnip", qty: 4 }] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("SELL");
    expect(res.parsed?.target).toEqual({ itemId: "crop:parsnip", qty: 4 });
  });

  it("carries the harvest to the shop when away from it", async () => {
    const obs = makeObs({ self: { inventory: [{ itemId: "crop:parsnip", qty: 4 }] } });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("MOVE_TO");
    expect(res.parsed?.target).toEqual(SHOP);
  });

  it("buys parsnip seeds at the shop when out of seeds", async () => {
    const obs = makeObs({ self: { pos: { x: 10, y: 6 }, gold: 100, inventory: [] } });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("BUY");
    expect(res.parsed?.target).toEqual({ itemId: "seed:parsnip", qty: 3 });
  });

  it("heads to the shop when out of seeds and away from it", async () => {
    const res = await decideFor(makeObs());
    expect(res.parsed?.action).toBe("MOVE_TO");
    expect(res.parsed?.target).toEqual(SHOP);
  });

  it("waits when nothing is available or useful", async () => {
    const obs = makeObs({
      self: { pos: { x: 10, y: 6 }, gold: 0 },
      nearby: { landmarks: [] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("WAIT");
  });

  it("respects availableActions (never harvests when HARVEST is unavailable)", async () => {
    const obs = makeObs({
      availableActions: ["MOVE_TO", "SLEEP", "WAIT"],
      nearby: {
        tiles: [
          {
            x: 5,
            y: 6,
            type: "tilled",
            crop: { kind: "parsnip", stage: 4, watered: true, ready: true },
          },
        ],
      },
    });
    const res = await decideFor(obs);
    expect(["MOVE_TO", "SLEEP", "WAIT"]).toContain(res.parsed?.action);
  });
});

describe("mockRouter — persona flavor (deterministic)", () => {
  it("social personas sometimes chat with adjacent agents, never with nobody near", async () => {
    const actions: string[] = [];
    for (let day = 1; day <= 12; day++) {
      const obs = makeObs({
        self: { name: "Sage", persona: "Social Sage — loves a chat" },
        time: { day, phase: "morning" },
        nearby: { agents: [{ name: "Dora", pos: { x: 5, y: 6 }, lastSeenDoing: "tilling" }] },
      });
      const res = await decideFor(obs);
      actions.push(res.parsed!.action);
      if (res.parsed!.action === "TALK_TO") {
        expect(res.parsed!.target).toEqual({ agentName: "Dora" });
      }
    }
    expect(actions).toContain("TALK_TO");
    expect(actions.filter((a) => a !== "TALK_TO").length).toBeGreaterThan(0);

    // No agent nearby -> never TALK_TO.
    const lonely = await decideFor(
      makeObs({ self: { name: "Sage", persona: "Social Sage — loves a chat" } }),
    );
    expect(lonely.parsed?.action).not.toBe("TALK_TO");
  });

  it("reckless personas deterministically skip watering some days; diligent never do", async () => {
    const thirstyTiles = [
      {
        x: 4,
        y: 5,
        type: "tilled" as const,
        crop: { kind: "parsnip", stage: 1, watered: false, ready: false },
      },
    ];
    const rustyActions = new Set<string>();
    for (let day = 1; day <= 30; day++) {
      const obs = makeObs({
        self: { name: "Rusty", persona: "Reckless Rusty — forgets to water" },
        time: { day, phase: "morning" },
        nearby: { tiles: thirstyTiles },
      });
      const res = await decideFor(obs);
      rustyActions.add(res.parsed!.action);
    }
    expect(rustyActions.has("WATER")).toBe(true);
    expect(rustyActions.size).toBeGreaterThan(1); // skipped watering on some days

    for (let day = 1; day <= 30; day++) {
      const obs = makeObs({
        time: { day, phase: "morning" },
        nearby: { tiles: thirstyTiles },
      });
      const res = await decideFor(obs);
      expect(res.parsed?.action).toBe("WATER");
    }
  });
});
