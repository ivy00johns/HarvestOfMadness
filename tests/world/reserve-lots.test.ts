import { describe, expect, it } from "vitest";
import type { TileType, Vec2 } from "@contracts/types";
import { MAP_WIDTH, MAP_HEIGHT, OBSERVATION_RADIUS } from "@contracts/types";
import { generateMap, RESERVE_LOTS, exteriorOf } from "../../src/world/map";

const map = generateMap();
const at = (p: Vec2): TileType => map.tiles[p.y][p.x];

describe("reserve lots (future-homestead capacity)", () => {
  it("reserves at least 13 lots", () => {
    expect(RESERVE_LOTS.length).toBeGreaterThanOrEqual(13);
  });

  it("each lot is clear grass, in bounds, with a road-adjacent door and an in-range plot", () => {
    for (const lot of RESERVE_LOTS) {
      // footprint + plot are entirely grass (nothing stamped yet)
      for (let y = lot.house.y0; y <= lot.house.y1; y++)
        for (let x = lot.house.x0; x <= lot.house.x1; x++)
          expect(at({ x, y }), `lot ${lot.id} house tile ${x},${y}`).toBe("grass");
      for (let y = lot.plot.y0; y <= lot.plot.y1; y++)
        for (let x = lot.plot.x0; x <= lot.plot.x1; x++)
          expect(at({ x, y }), `lot ${lot.id} plot tile ${x},${y}`).toBe("grass");
      // bounds
      expect(lot.house.x0).toBeGreaterThan(0);
      expect(lot.house.y0).toBeGreaterThan(0);
      expect(lot.house.x1).toBeLessThan(MAP_WIDTH - 1);
      expect(lot.house.y1).toBeLessThan(MAP_HEIGHT - 1);
      // door's exterior neighbour is a road, so activation is drop-in
      expect(at(exteriorOf(lot.door, lot.doorSide)), `lot ${lot.id} door faces a road`).toBe("path");
      // plot within observation range of the door
      const cheb = (a: Vec2, b: Vec2) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      let nearest = Infinity;
      for (let y = lot.plot.y0; y <= lot.plot.y1; y++)
        for (let x = lot.plot.x0; x <= lot.plot.x1; x++)
          nearest = Math.min(nearest, cheb(lot.door, { x, y }));
      expect(nearest, `lot ${lot.id} plot in range`).toBeLessThanOrEqual(OBSERVATION_RADIUS);
    }
  });

  it("lots do not overlap any built room or another lot", () => {
    const occupied = new Set<string>();
    for (let y = 0; y < MAP_HEIGHT; y++)
      for (let x = 0; x < MAP_WIDTH; x++)
        if (map.tiles[y][x] !== "grass") occupied.add(`${x},${y}`);
    const claimed = new Set<string>();
    for (const lot of RESERVE_LOTS) {
      for (let y = lot.house.y0; y <= lot.house.y1; y++)
        for (let x = lot.house.x0; x <= lot.house.x1; x++) {
          const k = `${x},${y}`;
          expect(occupied.has(k), `lot ${lot.id} overlaps a built tile at ${k}`).toBe(false);
          expect(claimed.has(k), `lot ${lot.id} overlaps another lot at ${k}`).toBe(false);
          claimed.add(k);
        }
    }
  });
});
