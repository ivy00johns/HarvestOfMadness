import { describe, expect, it } from "vitest";
import { World } from "../../src/world/World";

const SOIL = { x: 9, y: 9 }; // inside the 8x6 soil field
const GRASS = { x: 3, y: 8 };
const WATER = { x: 8, y: 3 };
const BUILDING = { x: 2, y: 2 };
const WALL = { x: 0, y: 0 };

describe("World map + queries", () => {
  it("exposes the contract dimensions", () => {
    const w = new World();
    expect(w.width).toBe(48);
    expect(w.height).toBe(32);
  });

  it("getTile returns null out of bounds", () => {
    const w = new World();
    expect(w.getTile(-1, 0)).toBeNull();
    expect(w.getTile(48, 0)).toBeNull();
    expect(w.getTile(0, 32)).toBeNull();
    expect(w.getTile(5, 5)).not.toBeNull();
  });

  it("tilesInRadius is Chebyshev and clipped to the map", () => {
    const w = new World();
    // Interior: full (2r+1)^2 square.
    expect(w.tilesInRadius({ x: 12, y: 9 }, 2)).toHaveLength(25);
    // Corner clipping: (0,0) r=1 -> 2x2.
    expect(w.tilesInRadius({ x: 0, y: 0 }, 1)).toHaveLength(4);
    // Edge clipping: (1,1) r=4 -> x 0..5, y 0..5 = 36.
    const clipped = w.tilesInRadius({ x: 1, y: 1 }, 4);
    expect(clipped).toHaveLength(36);
    for (const t of clipped) {
      expect(Math.max(Math.abs(t.x - 1), Math.abs(t.y - 1))).toBeLessThanOrEqual(4);
    }
  });

  it("isPassable: grass/path/tilled/soil/bedTile/shopTile yes; water/building/wall no", () => {
    const w = new World();
    expect(w.isPassable(GRASS.x, GRASS.y)).toBe(true); // grass
    expect(w.isPassable(4, 6)).toBe(true); // path
    expect(w.isPassable(SOIL.x, SOIL.y)).toBe(true); // soil
    expect(w.isPassable(3, 4)).toBe(true); // bedTile
    expect(w.isPassable(19, 4)).toBe(true); // shopTile
    w.till(SOIL);
    expect(w.isPassable(SOIL.x, SOIL.y)).toBe(true); // tilled
    expect(w.isPassable(WATER.x, WATER.y)).toBe(false);
    expect(w.isPassable(BUILDING.x, BUILDING.y)).toBe(false);
    expect(w.isPassable(WALL.x, WALL.y)).toBe(false);
    expect(w.isPassable(-1, 5)).toBe(false); // out of bounds
  });

  it("isAdjacent: 4-neighbour or same tile, not diagonals", () => {
    const w = new World();
    expect(w.isAdjacent({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(true);
    expect(w.isAdjacent({ x: 5, y: 5 }, { x: 6, y: 5 })).toBe(true);
    expect(w.isAdjacent({ x: 5, y: 5 }, { x: 5, y: 4 })).toBe(true);
    expect(w.isAdjacent({ x: 5, y: 5 }, { x: 6, y: 6 })).toBe(false);
    expect(w.isAdjacent({ x: 5, y: 5 }, { x: 7, y: 5 })).toBe(false);
  });

  it("provides all four contract landmarks at expected tile types", () => {
    const w = new World();
    const byKind = Object.fromEntries(w.landmarks().map((l) => [l.kind, l.pos]));
    expect(w.getTile(byKind.bed.x, byKind.bed.y)!.type).toBe("bedTile");
    expect(w.getTile(byKind.shop.x, byKind.shop.y)!.type).toBe("shopTile");
    expect(w.getTile(byKind.water.x, byKind.water.y)!.type).toBe("water");
    expect(byKind.house).toBeDefined();
    // bed and shop are reachable from the house landmark.
    expect(w.findPath(byKind.house, byKind.bed)).not.toBeNull();
    expect(w.findPath(byKind.house, byKind.shop)).not.toBeNull();
  });
});

describe("Farm mutations — tile-level preconditions", () => {
  it("till: soil -> tilled ok", () => {
    const w = new World();
    expect(w.till(SOIL)).toEqual({ ok: true });
    expect(w.getTile(SOIL.x, SOIL.y)!.type).toBe("tilled");
  });

  it("till: grass -> tilled ok", () => {
    const w = new World();
    expect(w.till(GRASS).ok).toBe(true);
    expect(w.getTile(GRASS.x, GRASS.y)!.type).toBe("tilled");
  });

  it("till rejects water/building/wall/already-tilled/out-of-bounds with readable reasons", () => {
    const w = new World();
    const water = w.till(WATER);
    expect(water.ok).toBe(false);
    expect(water.reason).toContain("water");
    expect(water.reason).toContain(`(${WATER.x},${WATER.y})`);
    expect(w.till(BUILDING).reason).toContain("building");
    expect(w.till(WALL).reason).toContain("wall");
    w.till(SOIL);
    expect(w.till(SOIL).reason).toContain("already tilled");
    expect(w.till({ x: -1, y: 99 }).reason).toContain("outside the map");
  });

  it("plant: tilled + empty -> crop at stage 0, unwatered, not ready", () => {
    const w = new World();
    w.till(SOIL);
    expect(w.plant(SOIL, "parsnip")).toEqual({ ok: true });
    expect(w.getTile(SOIL.x, SOIL.y)!.crop).toEqual({
      kind: "parsnip",
      stage: 0,
      watered: false,
      ready: false,
    });
  });

  it("plant rejects untilled tiles, occupied tiles and out-of-bounds", () => {
    const w = new World();
    const untilled = w.plant(SOIL, "parsnip");
    expect(untilled.ok).toBe(false);
    expect(untilled.reason).toContain("not tilled");
    w.till(SOIL);
    w.plant(SOIL, "parsnip");
    const occupied = w.plant(SOIL, "potato");
    expect(occupied.ok).toBe(false);
    expect(occupied.reason).toContain("already has a parsnip");
    expect(w.plant({ x: 99, y: 0 }, "parsnip").reason).toContain("outside the map");
  });

  it("water: crop + unwatered -> watered; rejects no-crop and double-water", () => {
    const w = new World();
    const noCrop = w.water(SOIL);
    expect(noCrop.ok).toBe(false);
    expect(noCrop.reason).toContain("no crop");
    w.till(SOIL);
    w.plant(SOIL, "parsnip");
    expect(w.water(SOIL)).toEqual({ ok: true });
    expect(w.getTile(SOIL.x, SOIL.y)!.crop!.watered).toBe(true);
    const again = w.water(SOIL);
    expect(again.ok).toBe(false);
    expect(again.reason).toContain("already watered");
    expect(w.water({ x: -5, y: 0 }).reason).toContain("outside the map");
  });

  it("harvest: ready crop -> ok + itemId, tile back to bare tilled", () => {
    const w = new World();
    w.till(SOIL);
    w.plant(SOIL, "parsnip");
    for (let i = 0; i < 4; i++) {
      w.water(SOIL);
      w.advanceDay();
    }
    const r = w.harvest(SOIL);
    expect(r.ok).toBe(true);
    expect(r.itemId).toBe("crop:parsnip");
    const tile = w.getTile(SOIL.x, SOIL.y)!;
    expect(tile.type).toBe("tilled");
    expect(tile.crop).toBeUndefined();
  });

  it("harvest rejects no-crop and not-ready with readable reasons", () => {
    const w = new World();
    const noCrop = w.harvest(SOIL);
    expect(noCrop.ok).toBe(false);
    expect(noCrop.reason).toContain("no crop");
    expect(noCrop.itemId).toBeUndefined();
    w.till(SOIL);
    w.plant(SOIL, "parsnip");
    const notReady = w.harvest(SOIL);
    expect(notReady.ok).toBe(false);
    expect(notReady.reason).toContain("not ready");
    expect(w.harvest({ x: 50, y: 50 }).reason).toContain("outside the map");
  });
});

describe("advanceDay (SLEEP) crop semantics", () => {
  it("grows only watered crops, resets watered on ALL crops, recomputes ready", () => {
    const w = new World();
    const watered = { x: 9, y: 9 };
    const dry = { x: 10, y: 9 };
    for (const p of [watered, dry]) {
      w.till(p);
      w.plant(p, "parsnip");
    }
    w.water(watered);

    w.advanceDay();
    const wet = w.getTile(watered.x, watered.y)!.crop!;
    const parched = w.getTile(dry.x, dry.y)!.crop!;
    expect(wet.stage).toBe(1);
    expect(wet.watered).toBe(false); // reset
    expect(wet.ready).toBe(false);
    expect(parched.stage).toBe(0); // unwatered: no growth
    expect(parched.watered).toBe(false);
  });

  it("crop becomes ready when stage reaches CROPS[kind].days (parsnip = 4)", () => {
    const w = new World();
    w.till(SOIL);
    w.plant(SOIL, "parsnip");
    for (let day = 1; day <= 4; day++) {
      w.water(SOIL);
      w.advanceDay();
      const crop = w.getTile(SOIL.x, SOIL.y)!.crop!;
      expect(crop.stage).toBe(day);
      expect(crop.ready).toBe(day >= 4);
    }
  });

  it("advances the calendar: day+1, phase=morning", () => {
    const w = new World();
    w.timeSystem.step(); // afternoon
    w.timeSystem.step(); // evening
    expect(w.time()).toEqual({ day: 1, phase: "evening" });
    w.advanceDay();
    expect(w.time()).toEqual({ day: 2, phase: "morning" });
  });
});
