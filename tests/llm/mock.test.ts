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

const READY_CROP = { kind: "parsnip", stage: 4, watered: true, ready: true };
const THIRSTY_CROP = { kind: "parsnip", stage: 1, watered: false, ready: false };

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

  it("falls back to WAIT with thought 'observation unreadable' on garbage input", async () => {
    const res = await mockRouter({ agentId: "x", system: "s", user: "not json at all" });
    expect(res.parsed?.action).toBe("WAIT");
    expect(res.parsed?.thought).toBe("observation unreadable");
    expect(res.model).toBe("mock");
  });
});

describe("mockRouter — throw-proofing (QE hardening: the budget-fallback net never rejects)", () => {
  it("a parseable-but-partial observation resolves with a valid action", async () => {
    const res = await mockRouter({
      agentId: "X",
      system: "s",
      user: '{"self":{"name":"X"}} What do you do next?',
    });
    expect(res.parsed).toBeDefined();
    expect(parseAgentAction(res.raw)).toEqual(res.parsed);
    expect(res.model).toBe("mock");
  });

  it("an empty object observation resolves to WAIT", async () => {
    const res = await mockRouter({ agentId: "X", system: "s", user: "{}" });
    expect(res.parsed?.action).toBe("WAIT");
  });

  it("hostile field types never throw and always yield a valid action", async () => {
    const hostiles = [
      '{"self":42,"time":"night","nearby":[],"availableActions":"all"}',
      '{"self":{"pos":{"x":"a","y":null},"energy":"full","inventory":"nope"},"nearby":{"tiles":[{"x":1},{"x":2,"y":3,"crop":"weird"},null,7]}}',
      '{"self":{"name":"X","pos":{"x":1e400,"y":0}},"availableActions":["WAIT","DANCE",42]}',
      '{"time":{"day":{},"phase":"midnight"},"nearby":{"landmarks":[{"kind":"volcano","pos":{"x":1,"y":1}},{"kind":"bed"}]}}',
      '[{"self":null}] trailing prose {"also":"ignored"}',
    ];
    for (const user of hostiles) {
      const res = await mockRouter({ agentId: "X", system: "s", user });
      expect(res.parsed, user).toBeDefined();
      expect(parseAgentAction(res.raw), user).toEqual(res.parsed);
    }
  });

  it("a normalized full observation still plays the ladder (no behavior regression)", async () => {
    // Same as ladder step 1, routed through normalization untouched.
    const obs = makeObs({
      nearby: { tiles: [{ x: 5, y: 6, type: "tilled", crop: READY_CROP }] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("HARVEST");
  });
});

describe("mockRouter — kickoff ladder, step by step", () => {
  it("1. harvests an adjacent ready crop", async () => {
    const obs = makeObs({
      nearby: { tiles: [{ x: 5, y: 6, type: "tilled", crop: READY_CROP }] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("HARVEST");
    expect(res.parsed?.target).toEqual({ x: 5, y: 6 });
  });

  it("2. sells the harvest when at/adjacent to the shop", async () => {
    const obs = makeObs({
      self: { pos: { x: 10, y: 6 }, inventory: [{ itemId: "crop:parsnip", qty: 4 }] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("SELL");
    expect(res.parsed?.target).toEqual({ itemId: "crop:parsnip", qty: 4 });
  });

  it("3. plants on an adjacent empty tilled tile when holding seeds", async () => {
    const obs = makeObs({
      self: { inventory: [{ itemId: "seed:parsnip", qty: 3 }] },
      nearby: { tiles: [{ x: 5, y: 4, type: "tilled" }] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("PLANT");
    expect(res.parsed?.target).toEqual({ x: 5, y: 4 });
  });

  it("4. waters an adjacent unwatered crop when energy > 0", async () => {
    const obs = makeObs({
      nearby: { tiles: [{ x: 4, y: 5, type: "tilled", crop: THIRSTY_CROP }] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("WATER");
    expect(res.parsed?.target).toEqual({ x: 4, y: 5 });
  });

  it("4. does not water at energy 0", async () => {
    const obs = makeObs({
      self: { energy: 0, pos: { x: 2, y: 2 } }, // on bed so step 6 resolves
      nearby: { tiles: [{ x: 2, y: 3, type: "tilled", crop: THIRSTY_CROP }] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).not.toBe("WATER");
  });

  it("5. tills adjacent untilled soil when energy > 0", async () => {
    const obs = makeObs({ nearby: { tiles: [{ x: 6, y: 5, type: "soil" }] } });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("TILL");
    expect(res.parsed?.target).toEqual({ x: 6, y: 5 });
  });

  it("6. sleeps only at night AND on the bed tile", async () => {
    const onBedAtNight = await decideFor(
      makeObs({ time: { day: 2, phase: "night" }, self: { pos: { ...BED } } }),
    );
    expect(onBedAtNight.parsed?.action).toBe("SLEEP");

    // Adjacent (not on) the bed at night -> walk onto it, never SLEEP.
    // (Seeds in pocket keep the step-7 shop run quiet.)
    const nextToBed = await decideFor(
      makeObs({
        time: { day: 2, phase: "night" },
        self: { pos: { x: 2, y: 3 }, inventory: [{ itemId: "seed:parsnip", qty: 1 }] },
      }),
    );
    expect(nextToBed.parsed?.action).toBe("MOVE_TO");
    expect(nextToBed.parsed?.target).toEqual(BED);
  });

  it("6. waits (does not sleep) when exhausted at bed during the day", async () => {
    const res = await decideFor(makeObs({ self: { energy: 0, pos: { ...BED } } }));
    expect(res.parsed?.action).toBe("WAIT");
  });

  it("7. buys parsnip seeds at the shop when out of seeds and gold suffices", async () => {
    const obs = makeObs({ self: { pos: { x: 10, y: 6 }, gold: 100, inventory: [] } });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("BUY");
    expect(res.parsed?.target).toEqual({ itemId: "seed:parsnip", qty: 3 });
  });

  it("7. heads to the shop when out of seeds and away from it", async () => {
    const res = await decideFor(makeObs());
    expect(res.parsed?.action).toBe("MOVE_TO");
    expect(res.parsed?.target).toEqual(SHOP);
  });

  it("8. moves toward a ready crop that is out of reach", async () => {
    const obs = makeObs({
      self: { inventory: [{ itemId: "seed:parsnip", qty: 1 }] }, // keep step 7 quiet
      nearby: { tiles: [{ x: 8, y: 8, type: "tilled", crop: READY_CROP }] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("MOVE_TO");
    expect(res.parsed?.target).toEqual({ x: 8, y: 8 });
  });

  it("8. heads to bed at night / when exhausted", async () => {
    const night = await decideFor(
      makeObs({
        time: { day: 2, phase: "night" },
        self: { inventory: [{ itemId: "seed:parsnip", qty: 1 }] },
      }),
    );
    expect(night.parsed?.action).toBe("MOVE_TO");
    expect(night.parsed?.target).toEqual(BED);

    // Energy 0 skips the step-7 shop run (only MOVE_TO(bed)/WAIT legal at 0).
    const exhausted = await decideFor(makeObs({ self: { energy: 0 } }));
    expect(exhausted.parsed?.action).toBe("MOVE_TO");
    expect(exhausted.parsed?.target).toEqual(BED);
  });

  it("7-before-8: a seedless agent at night still makes the shop run first", async () => {
    const res = await decideFor(makeObs({ time: { day: 2, phase: "night" } }));
    expect(res.parsed?.action).toBe("MOVE_TO");
    expect(res.parsed?.target).toEqual(SHOP);
  });

  it("8. picks the closest actionable tile, category order breaking ties", async () => {
    // soil and ready crop both at distance 2 -> soil wins (untilled soil first)
    const tied = await decideFor(
      makeObs({
        self: { inventory: [{ itemId: "seed:parsnip", qty: 1 }] },
        nearby: {
          tiles: [
            { x: 7, y: 5, type: "soil" },
            { x: 3, y: 5, type: "tilled", crop: READY_CROP },
          ],
        },
      }),
    );
    expect(tied.parsed?.action).toBe("MOVE_TO");
    expect(tied.parsed?.target).toEqual({ x: 7, y: 5 });

    // closer ready crop beats farther soil despite category order
    const closer = await decideFor(
      makeObs({
        self: { inventory: [{ itemId: "seed:parsnip", qty: 1 }] },
        nearby: {
          tiles: [
            { x: 9, y: 5, type: "soil" },
            { x: 3, y: 5, type: "tilled", crop: READY_CROP },
          ],
        },
      }),
    );
    expect(closer.parsed?.action).toBe("MOVE_TO");
    expect(closer.parsed?.target).toEqual({ x: 3, y: 5 });
  });

  it("9. waits when nothing is actionable", async () => {
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
      nearby: { tiles: [{ x: 5, y: 6, type: "tilled", crop: READY_CROP }] },
    });
    const res = await decideFor(obs);
    expect(["MOVE_TO", "SLEEP", "WAIT"]).toContain(res.parsed?.action);
  });
});

describe("mockRouter — ladder precedence", () => {
  it("HARVEST (1) outranks SELL (2)", async () => {
    const obs = makeObs({
      self: { pos: { x: 10, y: 6 }, inventory: [{ itemId: "crop:parsnip", qty: 2 }] },
      nearby: { tiles: [{ x: 10, y: 7, type: "tilled", crop: READY_CROP }] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("HARVEST");
  });

  it("SELL (2) outranks PLANT (3)", async () => {
    const obs = makeObs({
      self: {
        pos: { x: 10, y: 6 },
        inventory: [
          { itemId: "crop:parsnip", qty: 2 },
          { itemId: "seed:parsnip", qty: 2 },
        ],
      },
      nearby: { tiles: [{ x: 10, y: 7, type: "tilled" }] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("SELL");
  });

  it("PLANT (3) outranks WATER (4)", async () => {
    const obs = makeObs({
      self: { inventory: [{ itemId: "seed:parsnip", qty: 2 }] },
      nearby: {
        tiles: [
          { x: 5, y: 4, type: "tilled" },
          { x: 4, y: 5, type: "tilled", crop: THIRSTY_CROP },
        ],
      },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("PLANT");
  });

  it("WATER (4) outranks TILL (5)", async () => {
    const obs = makeObs({
      nearby: {
        tiles: [
          { x: 4, y: 5, type: "tilled", crop: THIRSTY_CROP },
          { x: 6, y: 5, type: "soil" },
        ],
      },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("WATER");
  });

  it("TILL (5) outranks the seed shop run (7)", async () => {
    const obs = makeObs({
      self: { gold: 100, inventory: [] },
      nearby: { tiles: [{ x: 6, y: 5, type: "soil" }] },
    });
    const res = await decideFor(obs);
    expect(res.parsed?.action).toBe("TILL");
  });
});

describe("mockRouter — persona flavor (deterministic, after the ladder)", () => {
  it("social personas sometimes chat instead of idling, never preempting farm work", async () => {
    const actions: string[] = [];
    for (let day = 1; day <= 12; day++) {
      const obs = makeObs({
        // gold 0 + no seeds + no tiles -> the ladder bottoms out at WAIT
        self: { name: "Sage", persona: "Social Sage — loves a chat", gold: 0 },
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
    expect(actions).toContain("WAIT");

    // Real work on the ladder -> no chatting even with a neighbor present.
    const busy = await decideFor(
      makeObs({
        self: { name: "Sage", persona: "Social Sage — loves a chat" },
        nearby: {
          tiles: [{ x: 5, y: 6, type: "tilled", crop: READY_CROP }],
          agents: [{ name: "Dora", pos: { x: 5, y: 4 }, lastSeenDoing: "tilling" }],
        },
      }),
    );
    expect(busy.parsed?.action).toBe("HARVEST");

    // No agent nearby -> never TALK_TO.
    const lonely = await decideFor(
      makeObs({ self: { name: "Sage", persona: "Social Sage — loves a chat", gold: 0 } }),
    );
    expect(lonely.parsed?.action).not.toBe("TALK_TO");
  });

  it("reckless personas deterministically skip watering some days; diligent never do", async () => {
    const thirstyTiles = [{ x: 4, y: 5, type: "tilled" as const, crop: THIRSTY_CROP }];
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
