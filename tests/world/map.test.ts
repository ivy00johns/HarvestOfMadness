import { describe, expect, it } from "vitest";
import type { TileType, Vec2 } from "@contracts/types";
import { MAP_HEIGHT, MAP_WIDTH, OBSERVATION_RADIUS } from "@contracts/types";
import {
  BED_POS,
  FIELD_RECT,
  generateMap,
  HOMESTEADS,
  SHOP_POS,
} from "../../src/world/map";

const map = generateMap();
const at = (p: Vec2): TileType => map.tiles[p.y][p.x];

describe("town generator", () => {
  it("is 48x32 with an intact wall ring", () => {
    expect(map.width).toBe(48);
    expect(map.height).toBe(32);
    for (let x = 0; x < MAP_WIDTH; x++) {
      expect(map.tiles[0][x]).toBe("wall");
      expect(map.tiles[MAP_HEIGHT - 1][x]).toBe("wall");
    }
    for (let y = 0; y < MAP_HEIGHT; y++) {
      expect(map.tiles[y][0]).toBe("wall");
      expect(map.tiles[y][MAP_WIDTH - 1]).toBe("wall");
    }
  });

  it("has exactly six homesteads, each a house + bed + door + plot", () => {
    expect(HOMESTEADS).toHaveLength(6);
    for (const h of HOMESTEADS) {
      for (let y = h.house.y; y <= h.house.y + 2; y++) {
        for (let x = h.house.x; x <= h.house.x + 2; x++) {
          const t = map.tiles[y][x];
          expect(t === "building" || t === "bedTile", `house tile ${x},${y}`).toBe(true);
        }
      }
      expect(at(h.bed)).toBe("bedTile");
      expect(at(h.door)).toBe("path");
      for (let y = h.plot.y0; y <= h.plot.y1; y++) {
        for (let x = h.plot.x0; x <= h.plot.x1; x++) {
          expect(at({ x, y }), `plot tile ${x},${y}`).toBe("soil");
        }
      }
    }
  });

  it("has exactly 6 bedTiles and the expected landmark counts", () => {
    let beds = 0;
    for (let y = 0; y < MAP_HEIGHT; y++)
      for (let x = 0; x < MAP_WIDTH; x++) if (map.tiles[y][x] === "bedTile") beds++;
    expect(beds).toBe(6);
    const count = (k: string) => map.landmarks.filter((l) => l.kind === k).length;
    expect(count("bed")).toBe(6);
    expect(count("house")).toBe(6);
    expect(count("shop")).toBe(1);
    expect(count("tavern")).toBe(1);
    expect(count("water")).toBeGreaterThanOrEqual(1);
  });

  it("keeps the back-compat exports valid (tests stand agents on them)", () => {
    expect(at(SHOP_POS)).toBe("shopTile");
    expect(at(BED_POS)).toBe("bedTile");
    expect(at({ x: FIELD_RECT.x0, y: FIELD_RECT.y0 })).toBe("soil");
    expect(at({ x: FIELD_RECT.x0 + 1, y: FIELD_RECT.y0 })).toBe("soil");
  });

  it("connects every homestead door + the shop to the tavern via passable tiles", () => {
    const tavern = map.landmarks.find((l) => l.kind === "tavern")!.pos;
    const impassable = new Set<TileType>(["wall", "water", "building"]);
    const key = (p: Vec2) => `${p.x},${p.y}`;
    const seen = new Set<string>([key(tavern)]);
    const queue: Vec2[] = [tavern];
    while (queue.length) {
      const p = queue.shift()!;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const n = { x: p.x + dx, y: p.y + dy };
        if (n.x < 0 || n.y < 0 || n.x >= MAP_WIDTH || n.y >= MAP_HEIGHT) continue;
        if (seen.has(key(n)) || impassable.has(map.tiles[n.y][n.x])) continue;
        seen.add(key(n));
        queue.push(n);
      }
    }
    for (const h of HOMESTEADS) expect(seen.has(key(h.door)), `door ${h.id}`).toBe(true);
    expect(seen.has(key(SHOP_POS)), "shop").toBe(true);
  });

  it("each homestead's plot is within observation range of its door (agents perceive their own plot)", () => {
    const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    for (const h of HOMESTEADS) {
      let nearest = Infinity;
      for (let y = h.plot.y0; y <= h.plot.y1; y++)
        for (let x = h.plot.x0; x <= h.plot.x1; x++)
          nearest = Math.min(nearest, cheb(h.door, { x, y }));
      expect(nearest, `plot for ${h.id} must be within OBSERVATION_RADIUS of its door`).toBeLessThanOrEqual(
        OBSERVATION_RADIUS,
      );
    }
  });

  it("scatters decor only on grass, within bounds, capped", () => {
    expect(map.decor.length).toBeGreaterThan(0);
    expect(map.decor.length).toBeLessThanOrEqual(16);
    for (const d of map.decor) {
      expect(d.kind).toBe("tree");
      expect(d.pos.x).toBeGreaterThan(0);
      expect(d.pos.y).toBeGreaterThan(0);
      expect(d.pos.x).toBeLessThan(MAP_WIDTH - 1);
      expect(d.pos.y).toBeLessThan(MAP_HEIGHT - 1);
      expect(map.tiles[d.pos.y][d.pos.x], `decor at ${d.pos.x},${d.pos.y}`).toBe("grass");
    }
  });
});
