/**
 * QE adversarial suite — §4.4 precondition × phase × energy edge matrix.
 *
 * Independent of the builders' executor tests: exhaustively sweeps the
 * SLEEP gate across every phase/position/energy combination, probes
 * HARVEST at every non-ready stage, and attacks BUY/SELL/TALK_TO/MOVE_TO
 * with boundary and hostile targets. Every rejection must carry a
 * readable reason (rule 1: reject loudly, never crash).
 */
import { describe, expect, it } from "vitest";
import type { AgentAction, Phase, Vec2 } from "@contracts/types";
import { CROPS, ENERGY_START, STARTING_GOLD } from "@contracts/types";
import { World } from "../../src/world/World";
import { BED_POS, FIELD_RECT, HOMESTEADS, SHOP_POS, WATER_POS } from "../../src/world/map";
import { Agent, type Persona } from "../../src/agents/Agent";
import { executeAction } from "../../src/agents/ActionExecutor";

const PHASES: readonly Phase[] = ["morning", "afternoon", "evening", "night"];

function makeAgent(pos: Vec2, name = "Probe"): Agent {
  const persona: Persona = {
    id: "probe",
    name,
    description: "a qe probe farmer",
    color: 0xffffff,
    start: pos,
  };
  return new Agent(persona);
}

/** Advance a fresh world's clock to the given phase (worlds start at morning). */
function setPhase(world: World, phase: Phase): void {
  while (world.time().phase !== phase) world.timeSystem.step();
}

function action(a: Partial<AgentAction> & { action: AgentAction["action"] }): AgentAction {
  return { thought: "qe", say: null, ...a };
}

const INSTANT = { msPerTile: 0 };

const SOIL: Vec2 = { x: FIELD_RECT.x0, y: FIELD_RECT.y0 }; // first plot soil
const SOIL_STAND: Vec2 = { x: FIELD_RECT.x0 + 1, y: FIELD_RECT.y0 }; // adjacent
// Open grass clear of all rooms/roads/plots (used as a generic "off the bed/shop" stand).
const OPEN: Vec2 = { x: 3, y: 18 };
// A house wall corner — the impassable room wall ring (replaces the old
// `building` interior fixture; `building` is retained-but-unused).
const HOUSE_WALL: Vec2 = { x: HOMESTEADS[0].house.x, y: HOMESTEADS[0].house.y };
// A DEEP interior floor cell (interior corner, not the door-gap and not the
// centre bed) — reachable ONLY by pathing in through the door, so MOVE_TO
// succeeding here proves agents walk into the room, not merely onto the threshold.
const INTERIOR_FLOOR: Vec2 = { x: HOMESTEADS[0].house.x + 1, y: HOMESTEADS[0].house.y + 1 };

describe("SLEEP gate matrix: phase × position × energy", () => {
  const positions: Array<{ label: string; pos: Vec2; onBed: boolean }> = [
    { label: "on bed", pos: { ...BED_POS }, onBed: true },
    { label: "off bed (open)", pos: { ...OPEN }, onBed: false },
  ];

  for (const phase of PHASES) {
    for (const { label, pos, onBed } of positions) {
      for (const energy of [0, ENERGY_START]) {
        const shouldSleep = onBed && phase === "night";
        it(`${phase} / ${label} / energy ${energy} -> ${shouldSleep ? "ok" : "rejected with readable reason"}`, async () => {
          const world = new World();
          setPhase(world, phase);
          const agent = makeAgent(pos);
          agent.energy = energy;
          const dayBefore = world.time().day;

          const r = await executeAction(agent, action({ action: "SLEEP" }), world, [], INSTANT);

          expect(r.ok).toBe(shouldSleep);
          if (shouldSleep) {
            // v1.2: SLEEP legal at bed even at energy 0; restores to 100; advances day.
            expect(agent.energy).toBe(ENERGY_START);
            expect(world.time()).toEqual({ day: dayBefore + 1, phase: "morning" });
          } else {
            expect(r.reason).toBeTruthy();
            expect((r.reason ?? "").length).toBeGreaterThan(10); // readable, not a code
            expect(world.time().day).toBe(dayBefore); // SLEEP is the ONLY day advance
            expect(agent.energy).toBe(energy); // failed sleep restores nothing
          }
        });
      }
    }
  }
});

describe("HARVEST non-ready crop — every pre-ready stage rejected, no side effects", () => {
  for (const kind of ["parsnip", "potato", "cauliflower"] as const) {
    it(`${kind}: stages 0..${CROPS[kind].days - 1} rejected; stage ${CROPS[kind].days} harvests`, async () => {
      const world = new World();
      expect(world.till(SOIL).ok).toBe(true);
      expect(world.plant(SOIL, kind).ok).toBe(true);
      const agent = makeAgent(SOIL_STAND);

      const tile = world.getTile(SOIL.x, SOIL.y)!;
      for (let stage = 0; stage < CROPS[kind].days; stage++) {
        tile.crop!.stage = stage;
        tile.crop!.ready = false;
        const energyBefore = agent.energy;
        const r = await executeAction(
          agent,
          action({ action: "HARVEST", target: { ...SOIL } }),
          world,
          [],
          INSTANT,
        );
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/not ready/);
        expect(agent.energy).toBe(energyBefore); // no charge on rejection
        expect(agent.countItem(`crop:${kind}`)).toBe(0); // nothing credited
        expect(tile.crop).toBeDefined(); // crop untouched
      }

      // Ripen via the real path: water + advanceDay from days-1.
      tile.crop!.stage = CROPS[kind].days - 1;
      expect(world.water(SOIL).ok).toBe(true);
      world.advanceDay();
      expect(tile.crop!.ready).toBe(true);
      const r = await executeAction(
        agent,
        action({ action: "HARVEST", target: { ...SOIL } }),
        world,
        [],
        INSTANT,
      );
      expect(r.ok).toBe(true);
      expect(agent.countItem(`crop:${kind}`)).toBe(1);
      expect(world.getTile(SOIL.x, SOIL.y)!.crop).toBeUndefined();
    });
  }
});

describe("PLANT failure consumes nothing", () => {
  it("rejected PLANT (untilled target) leaves seeds, energy untouched", async () => {
    const world = new World();
    const agent = makeAgent(SOIL_STAND);
    const seeds = agent.countItem("seed:parsnip");
    const r = await executeAction(
      agent,
      action({ action: "PLANT", target: { ...SOIL } }), // soil, never tilled
      world,
      [],
      INSTANT,
    );
    expect(r.ok).toBe(false);
    expect(agent.countItem("seed:parsnip")).toBe(seeds);
    expect(agent.energy).toBe(ENERGY_START);
  });
});

describe("energy floor boundaries", () => {
  it("TILL at energy 1 succeeds and floors at 0 (never negative)", async () => {
    const world = new World();
    const agent = makeAgent(SOIL_STAND);
    agent.energy = 1;
    const r = await executeAction(
      agent,
      action({ action: "TILL", target: { ...SOIL } }),
      world,
      [],
      INSTANT,
    );
    expect(r.ok).toBe(true);
    expect(agent.energy).toBe(0);
  });

  it("every field action at energy 0 is rejected with a readable reason", async () => {
    const world = new World();
    expect(world.till(SOIL).ok).toBe(true);
    const agent = makeAgent(SOIL_STAND);
    agent.energy = 0;
    for (const a of ["TILL", "PLANT", "WATER", "HARVEST"] as const) {
      const r = await executeAction(
        agent,
        action({ action: a, target: { ...SOIL } }),
        world,
        [],
        INSTANT,
      );
      expect(r.ok, a).toBe(false);
      expect(r.reason, a).toMatch(/energy/i);
    }
  });
});

describe("BUY edge matrix", () => {
  function shopAgent(gold: number): { world: World; agent: Agent } {
    const world = new World();
    const agent = makeAgent({ ...SHOP_POS });
    agent.gold = gold;
    return { world, agent };
  }

  it("BUY at the wrong tile is rejected even with plenty of gold", async () => {
    const world = new World();
    const agent = makeAgent({ x: 3, y: 6 }); // path, not shopTile
    const r = await executeAction(
      agent,
      action({ action: "BUY", target: { itemId: "seed:parsnip", qty: 1 } }),
      world,
      [],
      INSTANT,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/shop/i);
    expect(agent.gold).toBe(STARTING_GOLD);
  });

  it("BUY without enough gold is rejected and charges nothing", async () => {
    const { world, agent } = shopAgent(CROPS.parsnip.seedCost - 1);
    const r = await executeAction(
      agent,
      action({ action: "BUY", target: { itemId: "seed:parsnip", qty: 1 } }),
      world,
      [],
      INSTANT,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(agent.gold).toBe(CROPS.parsnip.seedCost - 1);
    expect(agent.countItem("seed:parsnip")).toBe(5); // starting seeds only
  });

  it("BUY with exactly enough gold succeeds and lands on 0g, never negative", async () => {
    const { world, agent } = shopAgent(CROPS.cauliflower.seedCost * 2);
    const r = await executeAction(
      agent,
      action({ action: "BUY", target: { itemId: "seed:cauliflower", qty: 2 } }),
      world,
      [],
      INSTANT,
    );
    expect(r.ok).toBe(true);
    expect(agent.gold).toBe(0);
    expect(agent.countItem("seed:cauliflower")).toBe(2);
  });

  it("fractional qty is rejected outright (hardened gate, 89ccf81): whole number >= 1", async () => {
    const { world, agent } = shopAgent(1000);
    const r = await executeAction(
      agent,
      action({ action: "BUY", target: { itemId: "seed:parsnip", qty: 2.9 } }),
      world,
      [],
      INSTANT,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/whole number >= 1/);
    expect(agent.gold).toBe(1000); // nothing charged
    expect(agent.countItem("seed:parsnip")).toBe(5); // nothing credited
  });

  it("qty 0, negative, and unknown items are rejected without mutation", async () => {
    const { world, agent } = shopAgent(1000);
    const attacks: Array<{ itemId: string; qty: number }> = [
      { itemId: "seed:parsnip", qty: 0 },
      { itemId: "seed:parsnip", qty: -5 },
      { itemId: "seed:parsnip", qty: 0.4 }, // fractional -> whole-number gate
      { itemId: "crop:parsnip", qty: 1 }, // shop does not sell crops
      { itemId: "seed:gold_dupe", qty: 1 },
    ];
    for (const target of attacks) {
      const r = await executeAction(agent, action({ action: "BUY", target }), world, [], INSTANT);
      expect(r.ok, JSON.stringify(target)).toBe(false);
      expect(r.reason, JSON.stringify(target)).toBeTruthy();
    }
    expect(agent.gold).toBe(1000);
    expect(agent.inventory).toEqual([{ itemId: "seed:parsnip", qty: 5 }]);
  });
});

describe("SELL edge matrix", () => {
  it("SELL more than held / unknown items / seeds rejected; partial holdings intact", async () => {
    const world = new World();
    const agent = makeAgent({ ...SHOP_POS });
    agent.addItem("crop:parsnip", 2);
    const attacks: Array<{ itemId: string; qty: number }> = [
      { itemId: "crop:parsnip", qty: 3 }, // more than held
      { itemId: "crop:potato", qty: 1 }, // none held
      { itemId: "seed:parsnip", qty: 1 }, // shop does not buy seeds
      { itemId: "crop:parsnip", qty: -1 },
      { itemId: "crop:parsnip", qty: 0 },
    ];
    for (const target of attacks) {
      const r = await executeAction(agent, action({ action: "SELL", target }), world, [], INSTANT);
      expect(r.ok, JSON.stringify(target)).toBe(false);
      expect(r.reason, JSON.stringify(target)).toBeTruthy();
    }
    expect(agent.gold).toBe(STARTING_GOLD);
    expect(agent.countItem("crop:parsnip")).toBe(2);
  });

  it("SELL off the shop tile rejected with a readable reason", async () => {
    const world = new World();
    const agent = makeAgent({ x: 3, y: 6 });
    agent.addItem("crop:parsnip", 1);
    const r = await executeAction(
      agent,
      action({ action: "SELL", target: { itemId: "crop:parsnip", qty: 1 } }),
      world,
      [],
      INSTANT,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/shop/i);
  });
});

describe("TALK_TO range edge matrix", () => {
  // Talker stands on open grass (clear of every 5×5 room footprint). TALK_TO is
  // range-only, so only the Chebyshev distances matter.
  const TALKER: Vec2 = { x: 10, y: 18 };
  function pair(other: Vec2): { world: World; agent: Agent; others: Agent[] } {
    const world = new World();
    const agent = makeAgent({ ...TALKER }, "Talker");
    const buddy = makeAgent(other, "Buddy");
    return { world, agent, others: [buddy] };
  }

  it("Chebyshev 1 (diagonal) succeeds; Chebyshev 2 rejected", async () => {
    const near = pair({ x: TALKER.x + 1, y: TALKER.y - 1 }); // diagonal = cheb 1
    const r1 = await executeAction(
      near.agent,
      action({ action: "TALK_TO", target: { agentName: "Buddy" } }),
      near.world,
      near.others,
      INSTANT,
    );
    expect(r1.ok).toBe(true);
    expect(near.agent.relationships["Buddy"]).toBe(1);

    const far = pair({ x: TALKER.x + 2, y: TALKER.y }); // cheb 2
    const r2 = await executeAction(
      far.agent,
      action({ action: "TALK_TO", target: { agentName: "Buddy" } }),
      far.world,
      far.others,
      INSTANT,
    );
    expect(r2.ok).toBe(false);
    expect(r2.reason).toMatch(/far|tile/i);
    expect(far.agent.relationships["Buddy"]).toBeUndefined();
  });

  it("talking to yourself and to ghosts is rejected", async () => {
    const { world, agent, others } = pair({ x: TALKER.x + 1, y: TALKER.y });
    const self = await executeAction(
      agent,
      action({ action: "TALK_TO", target: { agentName: "Talker" } }),
      world,
      [agent, ...others],
      INSTANT,
    );
    expect(self.ok).toBe(false);
    const ghost = await executeAction(
      agent,
      action({ action: "TALK_TO", target: { agentName: "Nobody" } }),
      world,
      others,
      INSTANT,
    );
    expect(ghost.ok).toBe(false);
    expect(ghost.reason).toContain("Nobody");
  });
});

describe("MOVE_TO hostile targets", () => {
  it("NaN / Infinity / fractional coordinates rejected, never crash", async () => {
    const world = new World();
    const agent = makeAgent({ x: 3, y: 6 });
    for (const target of [
      { x: Number.NaN, y: Number.NaN },
      { x: Infinity, y: 6 },
      { x: 3.5, y: 6.5 },
      { x: -1, y: -1 },
      { x: 1e9, y: 1e9 },
    ]) {
      const r = await executeAction(agent, action({ action: "MOVE_TO", target }), world, [], INSTANT);
      expect(r.ok, JSON.stringify(target)).toBe(false);
      expect(r.reason, JSON.stringify(target)).toBeTruthy();
    }
    expect(agent.pos).toEqual({ x: 3, y: 6 });
  });

  it("impassable targets (house wall / water / map wall) rejected", async () => {
    const world = new World();
    const agent = makeAgent({ ...OPEN });
    for (const target of [
      { ...HOUSE_WALL }, // a room's impassable wall ring (was a building interior)
      { ...WATER_POS }, // pond corner (water)
      { x: 0, y: 0 }, // map-border wall
    ]) {
      const r = await executeAction(agent, action({ action: "MOVE_TO", target }), world, [], INSTANT);
      expect(r.ok, JSON.stringify(target)).toBe(false);
      expect(r.reason, JSON.stringify(target)).toBeTruthy();
    }
  });

  it("walkable interiors: MOVE_TO an interior floor cell (the door-gap) succeeds", async () => {
    // Walkable-interiors feature: with the wall ring + single floor door-gap, the
    // room interior is reachable via A* (door-only entry comes for free).
    const world = new World();
    const agent = makeAgent({ ...OPEN });
    const r = await executeAction(
      agent,
      action({ action: "MOVE_TO", target: { ...INTERIOR_FLOOR } }),
      world,
      [],
      INSTANT,
    );
    expect(r.ok, JSON.stringify(INTERIOR_FLOOR)).toBe(true);
    expect(agent.pos).toEqual(INTERIOR_FLOOR);
  });
});

describe("hostile non-finite quantities (defense-in-depth vs a bypassing router)", () => {
  // parse.ts rejects non-finite qty, so a conforming router can never deliver
  // these. A custom/buggy router could. RESOLVED in 89ccf81: the executor's
  // isItemTarget/isVec2 now mirror parse.ts finiteness and gateQty enforces
  // whole-number >= 1 — NaN can no longer corrupt gold or inventory.
  it("BUY with qty NaN is rejected and gold stays finite", async () => {
    const world = new World();
    const agent = makeAgent({ ...SHOP_POS });
    const r = await executeAction(
      agent,
      action({ action: "BUY", target: { itemId: "seed:parsnip", qty: Number.NaN } }),
      world,
      [],
      INSTANT,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(agent.gold).toBe(STARTING_GOLD); // untouched, and finite
  });

  it("SELL with qty NaN is rejected and inventory/gold stay finite", async () => {
    const world = new World();
    const agent = makeAgent({ ...SHOP_POS });
    agent.addItem("crop:parsnip", 2);
    const r = await executeAction(
      agent,
      action({ action: "SELL", target: { itemId: "crop:parsnip", qty: Number.NaN } }),
      world,
      [],
      INSTANT,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(agent.countItem("crop:parsnip")).toBe(2); // untouched, and finite
    expect(agent.gold).toBe(STARTING_GOLD);
  });

  it("BUY/SELL with qty Infinity are rejected by the gold/holdings gates", async () => {
    const world = new World();
    const agent = makeAgent({ ...SHOP_POS });
    agent.addItem("crop:parsnip", 2);
    const buy = await executeAction(
      agent,
      action({ action: "BUY", target: { itemId: "seed:parsnip", qty: Infinity } }),
      world,
      [],
      INSTANT,
    );
    expect(buy.ok).toBe(false);
    const sell = await executeAction(
      agent,
      action({ action: "SELL", target: { itemId: "crop:parsnip", qty: Infinity } }),
      world,
      [],
      INSTANT,
    );
    expect(sell.ok).toBe(false);
    expect(agent.gold).toBe(STARTING_GOLD);
    expect(agent.countItem("crop:parsnip")).toBe(2);
  });
});

describe("unknown action from a hostile payload", () => {
  it("rejects with a readable reason instead of crashing", async () => {
    const world = new World();
    const agent = makeAgent({ x: 3, y: 6 });
    const hostile = { thought: "qe", say: null, action: "DELETE_FARM" } as unknown as AgentAction;
    const r = await executeAction(agent, hostile, world, [], INSTANT);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("DELETE_FARM");
  });
});
