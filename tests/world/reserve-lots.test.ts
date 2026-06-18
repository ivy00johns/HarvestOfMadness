import { describe, expect, it } from "vitest";
import type { TileType, Vec2 } from "@contracts/types";
import { MAP_HEIGHT, MAP_WIDTH, OBSERVATION_RADIUS } from "@contracts/types";
import { exteriorOf, generateMap, RESERVE_LOTS } from "../../src/world/map";

const map = generateMap();
const at = (p: Vec2): TileType => map.tiles[p.y][p.x];
const cheb = (a: Vec2, b: Vec2) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

describe("reserve lots (future-hamlet capacity, stamp NOTHING)", () => {
  it("reserves at least 14 drop-in lots", () => {
    expect(RESERVE_LOTS.length).toBeGreaterThanOrEqual(14);
  });

  it("every lot's house footprint AND plot are entirely grass (nothing stamped)", () => {
    for (const lot of RESERVE_LOTS) {
      for (let y = lot.house.y0; y <= lot.house.y1; y++)
        for (let x = lot.house.x0; x <= lot.house.x1; x++)
          expect(at({ x, y }), `${lot.id} house tile ${x},${y}`).toBe("grass");
      for (let y = lot.plot.y0; y <= lot.plot.y1; y++)
        for (let x = lot.plot.x0; x <= lot.plot.x1; x++)
          expect(at({ x, y }), `${lot.id} plot tile ${x},${y}`).toBe("grass");
    }
  });

  it("every lot is in bounds (off the wall ring)", () => {
    for (const lot of RESERVE_LOTS) {
      const xs = [lot.house.x0, lot.house.x1, lot.plot.x0, lot.plot.x1, lot.bed.x, lot.door.x];
      const ys = [lot.house.y0, lot.house.y1, lot.plot.y0, lot.plot.y1, lot.bed.y, lot.door.y];
      for (const x of xs) {
        expect(x, `${lot.id} x in bounds`).toBeGreaterThan(0);
        expect(x).toBeLessThan(MAP_WIDTH - 1);
      }
      for (const y of ys) {
        expect(y, `${lot.id} y in bounds`).toBeGreaterThan(0);
        expect(y).toBeLessThan(MAP_HEIGHT - 1);
      }
    }
  });

  it("every lot's door exterior is a path tile (drop-in activation onto a road)", () => {
    for (const lot of RESERVE_LOTS) {
      const ext = exteriorOf(lot.door, lot.doorSide);
      expect(at(ext), `${lot.id} door exterior ${ext.x},${ext.y} is a road path`).toBe("path");
    }
  });

  it("every lot's plot nearest cell is within OBSERVATION_RADIUS of its door", () => {
    for (const lot of RESERVE_LOTS) {
      let nearest = Infinity;
      for (let y = lot.plot.y0; y <= lot.plot.y1; y++)
        for (let x = lot.plot.x0; x <= lot.plot.x1; x++)
          nearest = Math.min(nearest, cheb(lot.door, { x, y }));
      expect(nearest, `${lot.id} plot within OBSERVATION_RADIUS of door`).toBeLessThanOrEqual(
        OBSERVATION_RADIUS,
      );
    }
  });

  it("no lot footprint overlaps a non-grass tile or any other lot footprint", () => {
    const claimed = new Set<string>();
    for (const lot of RESERVE_LOTS) {
      for (let y = lot.house.y0; y <= lot.house.y1; y++)
        for (let x = lot.house.x0; x <= lot.house.x1; x++) {
          // not over any non-grass tile
          expect(at({ x, y }), `${lot.id} footprint tile ${x},${y} not over non-grass`).toBe(
            "grass",
          );
          // not over another lot's footprint
          const k = `${x},${y}`;
          expect(claimed.has(k), `${lot.id} footprint overlaps another lot at ${k}`).toBe(false);
          claimed.add(k);
        }
    }
  });
});
