/**
 * Observation assembly — availableActions honesty (energy-0 floor, night/bed
 * gating, shop gating, plausible adjacent targets) + field passthrough.
 *
 * Farm-tile coordinates derive from FIELD_RECT (the first homestead's plot):
 * FARM_STAND is the agent's standing tile, FARM_SOIL an adjacent tillable cell.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Vec2 } from "@contracts/types";
import { getTimeSystem, getWorld, resetWorldForTests } from "../../src/world/instance";
import { BED_POS, FIELD_RECT, SHOP_POS } from "../../src/world/map";
import { Agent } from "../../src/agents/Agent";
import { buildObservation, computeAvailableActions } from "../../src/agents/Observation";

// Standing tile + adjacent soil cells from the first homestead's plot.
const FARM_STAND: Vec2 = { x: FIELD_RECT.x0 + 1, y: FIELD_RECT.y0 + 1 };
const FARM_SOIL: Vec2 = { x: FIELD_RECT.x0 + 1, y: FIELD_RECT.y0 }; // adjacent (north)

function makeAgent(pos: Vec2, name = "Tester"): Agent {
  return new Agent({
    id: name.toLowerCase(),
    name,
    description: "a test farmer",
    color: 0xffffff,
    start: pos,
  });
}

function avail(agent: Agent, others: Agent[] = []) {
  return computeAvailableActions(agent, getWorld(), others);
}

function toNight(): void {
  const ts = getTimeSystem();
  while (getWorld().time().phase !== "night") ts.step();
}

beforeEach(() => {
  resetWorldForTests();
});

describe("availableActions honesty", () => {
  it("always offers MOVE_TO and WAIT", () => {
    const a = makeAgent({ ...FARM_STAND });
    const acts = avail(a);
    expect(acts).toContain("MOVE_TO");
    expect(acts).toContain("WAIT");
  });

  it("energy 0 floor: only MOVE_TO/WAIT (plus SLEEP when on bed at night)", () => {
    const a = makeAgent({ ...FARM_STAND });
    a.energy = 0;
    expect(avail(a)).toEqual(["MOVE_TO", "WAIT"]);

    const sleeper = makeAgent({ ...BED_POS });
    sleeper.energy = 0;
    toNight();
    expect(avail(sleeper)).toEqual(["MOVE_TO", "SLEEP", "WAIT"]);
  });

  it("TILL only with an adjacent tillable tile and energy", () => {
    const onField = makeAgent({ ...FARM_STAND });
    expect(avail(onField)).toContain("TILL");
    const onShop = makeAgent({ ...SHOP_POS }); // shop interior — no adjacent soil
    expect(avail(onShop)).not.toContain("TILL");
  });

  it("PLANT needs an adjacent tilled empty tile AND a held seed", () => {
    const a = makeAgent({ ...FARM_STAND });
    expect(avail(a)).not.toContain("PLANT"); // nothing tilled yet
    getWorld().till({ ...FARM_SOIL });
    expect(avail(a)).toContain("PLANT");
    a.inventory = []; // no seed -> honest removal
    expect(avail(a)).not.toContain("PLANT");
    a.addItem("seed:potato", 1);
    getWorld().plant({ ...FARM_SOIL }, "parsnip"); // plot occupied
    expect(avail(a)).not.toContain("PLANT");
  });

  it("WATER/HARVEST track crop state on adjacent tiles", () => {
    const a = makeAgent({ ...FARM_STAND });
    getWorld().till({ ...FARM_SOIL });
    getWorld().plant({ ...FARM_SOIL }, "parsnip");
    expect(avail(a)).toContain("WATER");
    expect(avail(a)).not.toContain("HARVEST");

    getWorld().water({ ...FARM_SOIL });
    expect(avail(a)).not.toContain("WATER"); // already watered

    for (let d = 0; d < 4; d++) {
      getWorld().water({ ...FARM_SOIL });
      getWorld().advanceDay();
    }
    expect(avail(a)).toContain("HARVEST");
  });

  it("BUY/SELL only on the shop tile, gated by gold and sellables", () => {
    const a = makeAgent({ ...SHOP_POS });
    expect(avail(a)).toContain("BUY");
    expect(avail(a)).not.toContain("SELL"); // seeds are not sellable

    a.addItem("crop:parsnip", 1);
    expect(avail(a)).toContain("SELL");

    a.gold = 0;
    expect(avail(a)).not.toContain("BUY");

    const away = makeAgent({ ...FARM_STAND });
    away.addItem("crop:parsnip", 1);
    expect(avail(away)).not.toContain("BUY");
    expect(avail(away)).not.toContain("SELL");
  });

  it("TALK_TO only when another agent is within 1 tile", () => {
    const a = makeAgent({ x: 9, y: 18 }, "Alice");
    const near = makeAgent({ x: 10, y: 19 }, "Bob");
    const far = makeAgent({ x: 13, y: 18 }, "Cleo");
    expect(avail(a, [far])).not.toContain("TALK_TO");
    expect(avail(a, [near, far])).toContain("TALK_TO");
  });

  it("SLEEP only on the bed tile at night", () => {
    const onBed = makeAgent({ ...BED_POS });
    expect(avail(onBed)).not.toContain("SLEEP"); // morning
    toNight();
    expect(avail(onBed)).toContain("SLEEP");
    const nextDoor = makeAgent({ x: 3, y: 16 }); // off the bed (open grass)
    expect(avail(nextDoor)).not.toContain("SLEEP");
  });
});

describe("buildObservation", () => {
  it("assembles self, tiles in radius, agents, landmarks, economy", () => {
    // Agent on open ground with a full 9×9 window in-bounds; a buddy at Chebyshev
    // 4 (in radius) and a stranger at Chebyshev 12 (out of radius).
    const a = makeAgent({ x: 8, y: 18 });
    a.goal = "get rich";
    a.lastAction = { action: "TILL", ok: false, reason: "nope" };
    const buddy = makeAgent({ x: 11, y: 22 }, "Bob"); // max(3,4)=4, within radius
    buddy.lastSeenDoing = "tilling (11,21)";
    const stranger = makeAgent({ x: 20, y: 20 }, "Far"); // max(12,2)=12, beyond radius 4

    const obs = buildObservation(a, getWorld(), [buddy, stranger]);
    expect(obs.self).toMatchObject({
      name: "Tester",
      role: "farmer",
      pos: { x: 8, y: 18 },
      energy: 100,
      gold: 200, // STARTING_GOLD (v1.2)
      goal: "get rich",
    });
    expect(obs.self.inventory).toEqual([{ itemId: "seed:parsnip", qty: 5 }]); // STARTING_SEEDS
    expect(obs.nearby.tiles).toHaveLength(81); // full 9x9 within the map
    expect(obs.nearby.agents).toEqual([
      { name: "Bob", pos: { x: 11, y: 22 }, lastSeenDoing: "tilling (11,21)" },
    ]);
    // Landmarks are global knowledge (all returned regardless of position).
    const kinds = obs.nearby.landmarks.map((l) => l.kind);
    expect(kinds.filter((k) => k === "bed").length).toBe(10);
    expect(kinds.filter((k) => k === "house").length).toBe(10);
    expect(kinds.filter((k) => k === "shop").length).toBe(1);
    expect(kinds.filter((k) => k === "tavern").length).toBe(1);
    expect(kinds.filter((k) => k === "water").length).toBe(1);
    // Wave 5a — new civic + park landmarks surface to observation (additive).
    expect(kinds.filter((k) => k === "cafe").length).toBe(1);
    expect(kinds.filter((k) => k === "office").length).toBe(1);
    expect(kinds.filter((k) => k === "park").length).toBe(1);
    expect(obs.lastAction).toEqual({ action: "TILL", ok: false, reason: "nope" });
    expect(obs.economy.buys["seed:parsnip"]).toBe(20);
    expect(obs.economy.sells["crop:parsnip"]).toBe(35);
    expect(obs.time).toEqual({ day: 1, phase: "morning" });
  });

  it("includes crop state on visible tiles", () => {
    const a = makeAgent({ ...FARM_STAND });
    getWorld().till({ ...FARM_SOIL });
    getWorld().plant({ ...FARM_SOIL }, "parsnip");
    getWorld().water({ ...FARM_SOIL });
    const obs = buildObservation(a, getWorld(), []);
    const tile = obs.nearby.tiles.find((t) => t.x === FARM_SOIL.x && t.y === FARM_SOIL.y);
    expect(tile?.crop).toEqual({ kind: "parsnip", stage: 0, watered: true, ready: false });
  });
});
