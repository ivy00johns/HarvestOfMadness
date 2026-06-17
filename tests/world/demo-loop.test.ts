/**
 * Headless proof of the mission §14 phase-2 scripted loop: the exact
 * till -> plant -> water -> sleep x4 -> harvest -> sell sequence over
 * WorldApi, with executor-style gold bookkeeping, nets +15g for a parsnip.
 */
import { describe, expect, it } from "vitest";
import type { WorldApi } from "@contracts/types";
import { World } from "../../src/world/World";

describe("scripted demo loop (till->plant->water->sleep->harvest->sell)", () => {
  it("one parsnip yields gold delta +15", () => {
    const world: WorldApi = new World();
    const plot = { x: 9, y: 9 };
    let gold = 100;

    // BUY seed (gold mutation is executor-side; price is the world's).
    gold -= world.buyPrices()["seed:parsnip"];
    expect(gold).toBe(80);

    expect(world.till(plot).ok).toBe(true);
    expect(world.plant(plot, "parsnip").ok).toBe(true);

    for (let day = 0; day < 4; day++) {
      expect(world.water(plot).ok).toBe(true);
      world.advanceDay();
    }
    expect(world.time().day).toBe(5);
    expect(world.getTile(plot.x, plot.y)!.crop!.ready).toBe(true);

    const r = world.harvest(plot);
    expect(r.ok).toBe(true);
    expect(r.itemId).toBe("crop:parsnip");

    // SELL.
    gold += world.sellPrices()[r.itemId!];
    expect(gold).toBe(115); // net +15 over the starting 100
  });

  it("the loop respects ordering: harvesting a day early is rejected", () => {
    const world: WorldApi = new World();
    const plot = { x: 10, y: 10 };
    world.till(plot);
    world.plant(plot, "parsnip");
    for (let day = 0; day < 3; day++) {
      world.water(plot);
      world.advanceDay();
    }
    const early = world.harvest(plot);
    expect(early.ok).toBe(false);
    expect(early.itemId).toBeUndefined();
    // Finish the cycle properly.
    world.water(plot);
    world.advanceDay();
    expect(world.harvest(plot).ok).toBe(true);
  });
});
