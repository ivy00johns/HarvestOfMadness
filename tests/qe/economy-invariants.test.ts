/**
 * QE adversarial suite — economy invariants under a deterministic fuzz storm.
 *
 * Invariants (contracts/README.md rules 1-2, kickoff economy):
 *  - gold is never negative and never non-finite
 *  - inventory quantities are always positive integers (entries are pruned at 0)
 *  - BUY/SELL conservation: final gold === STARTING_GOLD − Σ(accepted buys) + Σ(accepted sells),
 *    and item counts match net accepted flow exactly (rejected ops change nothing)
 */
import { describe, expect, it } from "vitest";
import type { Vec2 } from "@contracts/types";
import { STARTING_GOLD } from "@contracts/types";
import { World } from "../../src/world/World";
import { FIELD_RECT, SHOP_POS } from "../../src/world/map";
import { Agent, type Persona } from "../../src/agents/Agent";
import { executeAction } from "../../src/agents/ActionExecutor";

// Farm fixtures from the first homestead's plot (soil). PLOT is the tilled
// target; FARM_STAND an adjacent soil cell to stand on while planting.
const PLOT: Vec2 = { x: FIELD_RECT.x0, y: FIELD_RECT.y0 };
const FARM_STAND: Vec2 = { x: FIELD_RECT.x0 + 1, y: FIELD_RECT.y0 };

/** mulberry32 — tiny deterministic PRNG so the fuzz replays identically. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeAgent(pos: Vec2): Agent {
  const persona: Persona = {
    id: "fuzz",
    name: "Fuzz",
    description: "an economy fuzzer",
    color: 0xffffff,
    start: pos,
  };
  return new Agent(persona);
}

const ITEMS = [
  "seed:parsnip",
  "seed:potato",
  "seed:cauliflower",
  "crop:parsnip",
  "crop:potato",
  "crop:cauliflower",
  "seed:unknown",
  "crop:unknown",
  "gold",
  "",
];

describe("economy fuzz: 500 hostile BUY/SELL ops on the shop tile", () => {
  it("gold/inventory invariants and exact conservation hold throughout", async () => {
    const world = new World();
    const agent = makeAgent({ ...SHOP_POS });
    // Give it something to sell so SELL paths actually exercise.
    agent.addItem("crop:parsnip", 10);
    agent.addItem("crop:cauliflower", 3);

    const buyPrices = world.buyPrices();
    const sellPrices = world.sellPrices();

    // Ledger of ACCEPTED ops only.
    let spent = 0;
    let earned = 0;
    const netFlow = new Map<string, number>(); // itemId -> net qty into inventory
    const startCounts = new Map<string, number>();
    for (const e of agent.inventory) startCounts.set(e.itemId, e.qty);

    const rand = mulberry32(0xc0ffee);
    const qtyPool = [1, 2, 3, 5, 0, -1, -100, 0.5, 2.9, 7, 1_000_000, Infinity, -Infinity];

    for (let i = 0; i < 500; i++) {
      const op = rand() < 0.5 ? "BUY" : "SELL";
      const itemId = ITEMS[Math.floor(rand() * ITEMS.length)];
      const qty = qtyPool[Math.floor(rand() * qtyPool.length)];

      const before = agent.gold;
      const r = await executeAction(
        agent,
        { thought: "fuzz", say: null, action: op, target: { itemId, qty } },
        world,
        [],
        { msPerTile: 0 },
      );

      if (r.ok) {
        const n = Math.floor(qty);
        expect(n, `accepted ${op} ${itemId} x${qty}`).toBeGreaterThanOrEqual(1);
        expect(Number.isFinite(n)).toBe(true);
        if (op === "BUY") {
          const cost = buyPrices[itemId] * n;
          spent += cost;
          netFlow.set(itemId, (netFlow.get(itemId) ?? 0) + n);
          expect(agent.gold).toBe(before - cost);
        } else {
          const gain = sellPrices[itemId] * n;
          earned += gain;
          netFlow.set(itemId, (netFlow.get(itemId) ?? 0) - n);
          expect(agent.gold).toBe(before + gain);
        }
      } else {
        expect(r.reason, `${op} ${itemId} x${qty}`).toBeTruthy();
        expect(agent.gold, `rejected op mutated gold: ${op} ${itemId} x${qty}`).toBe(before);
      }

      // Hard invariants after EVERY op.
      expect(Number.isFinite(agent.gold)).toBe(true);
      expect(agent.gold).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(agent.gold)).toBe(true);
      for (const entry of agent.inventory) {
        expect(Number.isInteger(entry.qty), entry.itemId).toBe(true);
        expect(entry.qty, entry.itemId).toBeGreaterThanOrEqual(1); // 0-qty entries pruned
      }
    }

    // Conservation: gold and item flow reconcile exactly.
    expect(agent.gold).toBe(STARTING_GOLD - spent + earned);
    const allIds = new Set([...startCounts.keys(), ...netFlow.keys()]);
    for (const id of allIds) {
      const expected = (startCounts.get(id) ?? 0) + (netFlow.get(id) ?? 0);
      expect(agent.countItem(id), id).toBe(expected);
    }
    // The fuzz must have actually traded (not 500 straight rejections).
    expect(spent).toBeGreaterThan(0);
    expect(earned).toBeGreaterThan(0);
  });
});

describe("harvest -> sell conservation (full loop accounting)", () => {
  it("one parsnip cycle: net gold delta is sellPrice − seedCost across BUY/PLANT/HARVEST/SELL", async () => {
    const world = new World();
    const agent = makeAgent({ ...SHOP_POS });
    agent.inventory = []; // start clean: must BUY the seed

    const buy = await executeAction(
      agent,
      { thought: "", say: null, action: "BUY", target: { itemId: "seed:parsnip", qty: 1 } },
      world,
      [],
      { msPerTile: 0 },
    );
    expect(buy.ok).toBe(true);

    // Teleport to the field (executor pathing is not under test here).
    agent.pos = { ...FARM_STAND };
    const plot = { ...PLOT };
    expect(world.till(plot).ok).toBe(true);
    const plant = await executeAction(
      agent,
      { thought: "", say: null, action: "PLANT", target: plot },
      world,
      [],
      { msPerTile: 0 },
    );
    expect(plant.ok).toBe(true);
    expect(agent.countItem("seed:parsnip")).toBe(0); // seed consumed exactly once

    for (let day = 0; day < 4; day++) {
      expect(world.water(plot).ok).toBe(true);
      world.advanceDay();
    }
    const harvest = await executeAction(
      agent,
      { thought: "", say: null, action: "HARVEST", target: plot },
      world,
      [],
      { msPerTile: 0 },
    );
    expect(harvest.ok).toBe(true);
    expect(agent.countItem("crop:parsnip")).toBe(1);

    agent.pos = { ...SHOP_POS };
    const sell = await executeAction(
      agent,
      { thought: "", say: null, action: "SELL", target: { itemId: "crop:parsnip", qty: 1 } },
      world,
      [],
      { msPerTile: 0 },
    );
    expect(sell.ok).toBe(true);
    expect(agent.countItem("crop:parsnip")).toBe(0);
    expect(agent.gold).toBe(STARTING_GOLD - 20 + 35); // v1.2 authoritative prices
  });
});
