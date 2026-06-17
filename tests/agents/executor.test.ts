/**
 * ActionExecutor — every §4.4 row: the ok path + each rejection, validated
 * against current world state via the real World (resetWorldForTests).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentAction, Vec2 } from "@contracts/types";
import { ENERGY_START } from "@contracts/types";
import { getTimeSystem, getWorld, resetWorldForTests } from "../../src/world/instance";
import { BED_POS, SHOP_POS } from "../../src/world/map";
import { Agent } from "../../src/agents/Agent";
import { executeAction } from "../../src/agents/ActionExecutor";

function makeAgent(pos: Vec2, name = "Tester"): Agent {
  return new Agent({
    id: name.toLowerCase(),
    name,
    description: "a test farmer",
    color: 0xffffff,
    start: pos,
  });
}

function act(action: AgentAction["action"], target?: AgentAction["target"]): AgentAction {
  return { thought: "t", say: null, action, ...(target !== undefined ? { target } : {}) };
}

/** Walk instantly in tests (delay 0 skips the timer entirely). */
const OPTS = { msPerTile: 0 };

function exec(agent: Agent, action: AgentAction, others: Agent[] = []) {
  return executeAction(agent, action, getWorld(), others, OPTS);
}

function toNight(): void {
  const ts = getTimeSystem();
  while (getWorld().time().phase !== "night") ts.step();
}

beforeEach(() => {
  resetWorldForTests();
});

describe("MOVE_TO", () => {
  it("walks a reachable passable target, updating pos", async () => {
    const a = makeAgent({ x: 3, y: 5 });
    const r = await exec(a, act("MOVE_TO", { x: 6, y: 6 }));
    expect(r.ok).toBe(true);
    expect(a.pos).toEqual({ x: 6, y: 6 });
  });

  it("same-tile move is a no-op success (path includes start)", async () => {
    const a = makeAgent({ x: 3, y: 5 });
    const r = await exec(a, act("MOVE_TO", { x: 3, y: 5 }));
    expect(r.ok).toBe(true);
    expect(a.pos).toEqual({ x: 3, y: 5 });
  });

  it("rejects an impassable target (water)", async () => {
    const a = makeAgent({ x: 3, y: 5 });
    const r = await exec(a, act("MOVE_TO", { x: 31, y: 10 })); // inside the pond
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not walkable/);
    expect(a.pos).toEqual({ x: 3, y: 5 });
  });

  it("rejects an out-of-map target", async () => {
    const a = makeAgent({ x: 3, y: 5 });
    const r = await exec(a, act("MOVE_TO", { x: -1, y: 99 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/outside the map/);
  });

  it("rejects a malformed target", async () => {
    const a = makeAgent({ x: 3, y: 5 });
    const r = await exec(a, act("MOVE_TO", { itemId: "seed:parsnip", qty: 1 }));
    expect(r.ok).toBe(false);
  });
});

describe("TILL", () => {
  it("tills adjacent soil and spends energy", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    const r = await exec(a, act("TILL", { x: 9, y: 8 }));
    expect(r.ok).toBe(true);
    expect(getWorld().getTile(9, 8)!.type).toBe("tilled");
    expect(a.energy).toBe(ENERGY_START - 2); // TILL costs 2 (v1.2)
  });

  it("rejects a non-adjacent target", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    const r = await exec(a, act("TILL", { x: 12, y: 12 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not adjacent/);
  });

  it("rejects at zero energy (floor rule)", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    a.energy = 0;
    const r = await exec(a, act("TILL", { x: 9, y: 8 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/energy/);
  });

  it("rejects already-tilled and untillable tiles", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    expect((await exec(a, act("TILL", { x: 9, y: 8 }))).ok).toBe(true);
    const again = await exec(a, act("TILL", { x: 9, y: 8 }));
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/already tilled/);

    const path = makeAgent({ x: 13, y: 9 });
    const onPath = await exec(path, act("TILL", { x: 12, y: 9 })); // x=12 vertical road
    expect(onPath.ok).toBe(false);
    expect(onPath.reason).toMatch(/not tillable/);
  });
});

describe("PLANT", () => {
  it("plants the first held seed on adjacent tilled soil", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    await exec(a, act("TILL", { x: 9, y: 8 }));
    const r = await exec(a, act("PLANT", { x: 9, y: 8 }));
    expect(r.ok).toBe(true);
    expect(a.countItem("seed:parsnip")).toBe(4); // started with 5 (v1.2)
    expect(getWorld().getTile(9, 8)!.crop).toMatchObject({ kind: "parsnip", stage: 0 });
    expect(a.energy).toBe(ENERGY_START - 3); // TILL 2 + PLANT 1
  });

  it("rejects without a seed", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    a.inventory = [];
    await exec(a, act("TILL", { x: 9, y: 8 }));
    const r = await exec(a, act("PLANT", { x: 9, y: 8 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no seeds/);
  });

  it("rejects untilled and occupied tiles", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    const raw = await exec(a, act("PLANT", { x: 9, y: 8 }));
    expect(raw.ok).toBe(false);
    expect(raw.reason).toMatch(/not tilled/);

    await exec(a, act("TILL", { x: 9, y: 8 }));
    await exec(a, act("PLANT", { x: 9, y: 8 }));
    a.addItem("seed:parsnip", 1);
    const occupied = await exec(a, act("PLANT", { x: 9, y: 8 }));
    expect(occupied.ok).toBe(false);
    expect(occupied.reason).toMatch(/already has/);
  });
});

describe("WATER", () => {
  async function planted(): Promise<Agent> {
    const a = makeAgent({ x: 9, y: 9 });
    await exec(a, act("TILL", { x: 9, y: 8 }));
    await exec(a, act("PLANT", { x: 9, y: 8 }));
    return a;
  }

  it("waters an adjacent unwatered crop", async () => {
    const a = await planted();
    const r = await exec(a, act("WATER", { x: 9, y: 8 }));
    expect(r.ok).toBe(true);
    expect(getWorld().getTile(9, 8)!.crop!.watered).toBe(true);
    expect(a.energy).toBe(ENERGY_START - 4); // TILL 2 + PLANT 1 + WATER 1
  });

  it("rejects an already-watered crop and a cropless tile", async () => {
    const a = await planted();
    await exec(a, act("WATER", { x: 9, y: 8 }));
    const again = await exec(a, act("WATER", { x: 9, y: 8 }));
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/already watered/);

    const empty = await exec(a, act("WATER", { x: 9, y: 10 }));
    expect(empty.ok).toBe(false);
    expect(empty.reason).toMatch(/no crop/);
  });
});

describe("HARVEST", () => {
  it("harvests a ready crop into inventory", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    await exec(a, act("TILL", { x: 9, y: 8 }));
    await exec(a, act("PLANT", { x: 9, y: 8 }));
    for (let d = 0; d < 4; d++) {
      getWorld().water({ x: 9, y: 8 });
      getWorld().advanceDay();
    }
    const energyBefore = a.energy;
    const r = await exec(a, act("HARVEST", { x: 9, y: 8 }));
    expect(r.ok).toBe(true);
    expect(a.countItem("crop:parsnip")).toBe(1);
    expect(a.energy).toBe(energyBefore - 2); // HARVEST costs 2
    expect(getWorld().getTile(9, 8)!.crop).toBeUndefined();
  });

  it("rejects an unready crop", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    await exec(a, act("TILL", { x: 9, y: 8 }));
    await exec(a, act("PLANT", { x: 9, y: 8 }));
    const r = await exec(a, act("HARVEST", { x: 9, y: 8 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not ready/);
    expect(a.countItem("crop:parsnip")).toBe(0);
  });
});

describe("BUY / SELL", () => {
  it("BUY exchanges gold for items on the shop tile", async () => {
    const a = makeAgent({ ...SHOP_POS });
    const r = await exec(a, act("BUY", { itemId: "seed:parsnip", qty: 2 }));
    expect(r.ok).toBe(true);
    expect(a.gold).toBe(160); // 200 - 2x20
    expect(a.countItem("seed:parsnip")).toBe(7); // 5 start + 2 bought
  });

  it("BUY rejects off the shop tile, with too little gold, unknown items, bad qty", async () => {
    const away = makeAgent({ x: 9, y: 9 });
    expect((await exec(away, act("BUY", { itemId: "seed:parsnip", qty: 1 }))).reason).toMatch(/shop tile/);

    const a = makeAgent({ ...SHOP_POS });
    expect((await exec(a, act("BUY", { itemId: "seed:cauliflower", qty: 10 }))).reason).toMatch(/only have/);
    expect((await exec(a, act("BUY", { itemId: "crop:gold", qty: 1 }))).reason).toMatch(/does not sell/);
    expect((await exec(a, act("BUY", { itemId: "seed:parsnip", qty: 0 }))).ok).toBe(false);
    expect(a.gold).toBe(200);
  });

  it("SELL exchanges items for gold on the shop tile", async () => {
    const a = makeAgent({ ...SHOP_POS });
    a.addItem("crop:parsnip", 2);
    const r = await exec(a, act("SELL", { itemId: "crop:parsnip", qty: 2 }));
    expect(r.ok).toBe(true);
    expect(a.gold).toBe(200 + 70);
    expect(a.countItem("crop:parsnip")).toBe(0);
  });

  it("SELL rejects off the shop tile, missing items, unknown items", async () => {
    const away = makeAgent({ x: 9, y: 9 });
    away.addItem("crop:parsnip", 1);
    expect((await exec(away, act("SELL", { itemId: "crop:parsnip", qty: 1 }))).reason).toMatch(/shop tile/);

    const a = makeAgent({ ...SHOP_POS });
    expect((await exec(a, act("SELL", { itemId: "crop:parsnip", qty: 1 }))).reason).toMatch(/you have 0/);
    expect((await exec(a, act("SELL", { itemId: "rock", qty: 1 }))).reason).toMatch(/does not buy/);
  });
});

describe("BUY / SELL hostile quantities (defense-in-depth vs a bypassing router)", () => {
  const hostileQtys = [Number.NaN, Infinity, -Infinity, -3, 0, 2.5];

  it("BUY rejects NaN/Infinity/fractional/negative qty and never corrupts gold or inventory", async () => {
    for (const qty of hostileQtys) {
      const a = makeAgent({ ...SHOP_POS });
      const r = await exec(a, act("BUY", { itemId: "seed:parsnip", qty }));
      expect(r.ok, `qty=${qty}`).toBe(false);
      expect(r.reason, `qty=${qty}`).toBeTruthy();
      expect(a.gold, `qty=${qty}`).toBe(200);
      expect(Number.isFinite(a.gold), `qty=${qty}`).toBe(true);
      expect(a.countItem("seed:parsnip"), `qty=${qty}`).toBe(5);
      expect(Number.isFinite(a.countItem("seed:parsnip")), `qty=${qty}`).toBe(true);
    }
  });

  it("SELL rejects NaN/Infinity/fractional/negative qty and never corrupts gold or inventory", async () => {
    for (const qty of hostileQtys) {
      const a = makeAgent({ ...SHOP_POS });
      a.addItem("crop:parsnip", 2);
      const r = await exec(a, act("SELL", { itemId: "crop:parsnip", qty }));
      expect(r.ok, `qty=${qty}`).toBe(false);
      expect(a.gold, `qty=${qty}`).toBe(200);
      expect(Number.isFinite(a.gold), `qty=${qty}`).toBe(true);
      expect(a.countItem("crop:parsnip"), `qty=${qty}`).toBe(2);
    }
  });

  it("MOVE_TO/field actions reject non-finite coordinates", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    expect((await exec(a, act("MOVE_TO", { x: Number.NaN, y: 9 }))).ok).toBe(false);
    expect((await exec(a, act("TILL", { x: 9, y: Infinity }))).ok).toBe(false);
    expect(a.pos).toEqual({ x: 9, y: 9 });
    expect(a.energy).toBe(100);
  });
});

describe("TALK_TO", () => {
  it("succeeds within 1 tile (Chebyshev) and bumps the relationship", async () => {
    const a = makeAgent({ x: 9, y: 9 }, "Alice");
    const b = makeAgent({ x: 10, y: 10 }, "Bob"); // diagonal counts
    const r = await exec(a, act("TALK_TO", { agentName: "Bob" }), [b]);
    expect(r.ok).toBe(true);
    expect(a.relationships["Bob"]).toBe(1);
  });

  it("rejects a distant or unknown partner", async () => {
    const a = makeAgent({ x: 9, y: 9 }, "Alice");
    const far = makeAgent({ x: 14, y: 9 }, "Bob");
    expect((await exec(a, act("TALK_TO", { agentName: "Bob" }), [far])).reason).toMatch(/too far/);
    expect((await exec(a, act("TALK_TO", { agentName: "Ghost" }), [far])).reason).toMatch(/no agent named/);
  });
});

describe("SLEEP", () => {
  it("advances the day and restores energy on the bed at night", async () => {
    const a = makeAgent({ ...BED_POS });
    a.energy = 12;
    toNight();
    const r = await exec(a, act("SLEEP"));
    expect(r.ok).toBe(true);
    expect(getWorld().time()).toEqual({ day: 2, phase: "morning" });
    expect(a.energy).toBe(ENERGY_START);
  });

  it("rejects outside night and off the bed", async () => {
    const onBedDay = makeAgent({ ...BED_POS });
    const day = await exec(onBedDay, act("SLEEP"));
    expect(day.ok).toBe(false);
    expect(day.reason).toMatch(/only SLEEP at night/);

    toNight();
    const offBed = makeAgent({ x: 9, y: 9 });
    const wrongTile = await exec(offBed, act("SLEEP"));
    expect(wrongTile.ok).toBe(false);
    expect(wrongTile.reason).toMatch(/on your bed/);
    expect(getWorld().time().day).toBe(1);
  });
});

describe("WAIT", () => {
  it("always succeeds, even at zero energy", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    a.energy = 0;
    const r = await exec(a, act("WAIT"));
    expect(r.ok).toBe(true);
    expect(a.energy).toBe(0);
  });
});
