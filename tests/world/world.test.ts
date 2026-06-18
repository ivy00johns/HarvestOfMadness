import { describe, expect, it } from "vitest";
import { MAP_HEIGHT, MAP_WIDTH } from "@contracts/types";
import { World } from "../../src/world/World";
import {
  BED_POS,
  FIELD_RECT,
  HOMESTEADS,
  SHOP_POS,
  WATER_POS,
} from "../../src/world/map";

// All map-coordinate fixtures derive from the generated map's exports so they
// follow any relayout. Soil from the first homestead's plot; a house wall corner
// (impassable); the pond corner (water); a walkable floor door-gap.
const SOIL = { x: FIELD_RECT.x0, y: FIELD_RECT.y0 }; // inside the first plot
const SOIL_B = { x: FIELD_RECT.x0 + 1, y: FIELD_RECT.y0 }; // a second plot soil
const GRASS = { x: 3, y: 18 }; // open grass, clear of rooms/roads
const WATER = { ...WATER_POS }; // the pond corner
const WALL = { x: 0, y: 0 }; // the map-border wall ring
// A house wall corner — the room's impassable wall ring (replaces the old
// `building` fixture; `building` is retained-but-unused, no tile stamps it).
const HOUSE_WALL = { x: HOMESTEADS[0].house.x, y: HOMESTEADS[0].house.y };
// A walkable `floor` tile — the first homestead's door-gap.
const FLOOR = { ...HOMESTEADS[0].door };

describe("World map + queries", () => {
  it("exposes the contract dimensions", () => {
    const w = new World();
    expect(w.width).toBe(MAP_WIDTH);
    expect(w.height).toBe(MAP_HEIGHT);
  });

  it("getTile returns null out of bounds", () => {
    const w = new World();
    expect(w.getTile(-1, 0)).toBeNull();
    expect(w.getTile(MAP_WIDTH, 0)).toBeNull();
    expect(w.getTile(0, MAP_HEIGHT)).toBeNull();
    expect(w.getTile(5, 5)).not.toBeNull();
  });

  it("tilesInRadius is Chebyshev and clipped to the map", () => {
    const w = new World();
    // Interior: full (2r+1)^2 square (a tile well clear of the border).
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

  it("isPassable: grass/path/tilled/soil/floor/bedTile/shopTile yes; water/house-wall/wall no", () => {
    const w = new World();
    expect(w.isPassable(GRASS.x, GRASS.y)).toBe(true); // grass
    expect(w.isPassable(10, 20)).toBe(true); // path (the town spine road)
    expect(w.isPassable(SOIL.x, SOIL.y)).toBe(true); // soil
    expect(w.isPassable(FLOOR.x, FLOOR.y)).toBe(true); // floor (door-gap) — walkable interiors
    expect(w.isPassable(BED_POS.x, BED_POS.y)).toBe(true); // bedTile
    expect(w.isPassable(SHOP_POS.x, SHOP_POS.y)).toBe(true); // shopTile
    w.till(SOIL);
    expect(w.isPassable(SOIL.x, SOIL.y)).toBe(true); // tilled
    expect(w.isPassable(WATER.x, WATER.y)).toBe(false);
    expect(w.isPassable(HOUSE_WALL.x, HOUSE_WALL.y)).toBe(false); // interior wall ring
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

  it("exposes the map's decor list (defensive copy, defaults empty)", () => {
    const w = new World();
    const decor = w.decor();
    expect(Array.isArray(decor)).toBe(true);
    expect(decor.length).toBeGreaterThan(0);
    // mutating the returned copy must not affect the world
    decor.length = 0;
    expect(w.decor().length).toBeGreaterThan(0);
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

  it("till rejects water/house-wall/wall/floor/already-tilled/out-of-bounds with readable reasons", () => {
    const w = new World();
    const water = w.till(WATER);
    expect(water.ok).toBe(false);
    expect(water.reason).toContain("water");
    expect(water.reason).toContain(`(${WATER.x},${WATER.y})`);
    expect(w.till(HOUSE_WALL).reason).toContain("wall");
    expect(w.till(WALL).reason).toContain("wall");
    // floor is passable but NOT tillable.
    expect(w.till(FLOOR).reason).toContain("floor");
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
    const watered = { ...SOIL };
    const dry = { ...SOIL_B };
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
