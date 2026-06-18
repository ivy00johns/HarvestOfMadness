import { describe, expect, it } from "vitest";
import type { TileType, Vec2 } from "@contracts/types";
import { MAP_HEIGHT, MAP_WIDTH, OBSERVATION_RADIUS } from "@contracts/types";
import {
  BED_POS,
  BUILDINGS,
  FIELD_RECT,
  generateMap,
  HOMESTEADS,
  SHOP_POS,
} from "../../src/world/map";

const map = generateMap();
const at = (p: Vec2): TileType => map.tiles[p.y][p.x];

describe("town generator", () => {
  it("is MAP_WIDTH×MAP_HEIGHT with an intact wall ring", () => {
    expect(map.width).toBe(MAP_WIDTH);
    expect(map.height).toBe(MAP_HEIGHT);
    for (let x = 0; x < MAP_WIDTH; x++) {
      expect(map.tiles[0][x]).toBe("wall");
      expect(map.tiles[MAP_HEIGHT - 1][x]).toBe("wall");
    }
    for (let y = 0; y < MAP_HEIGHT; y++) {
      expect(map.tiles[y][0]).toBe("wall");
      expect(map.tiles[y][MAP_WIDTH - 1]).toBe("wall");
    }
  });

  it("has exactly twelve walkable homesteads: 15 wall + 1 floor door perimeter, 8 floor + 1 bed interior", () => {
    expect(HOMESTEADS).toHaveLength(12);
    for (const h of HOMESTEADS) {
      const x0 = h.house.x;
      const y0 = h.house.y;
      const x1 = h.house.x + 4;
      const y1 = h.house.y + 4;

      // -- perimeter: exactly 15 wall + exactly 1 floor (the door-gap) --------
      let perimWall = 0;
      let perimFloor = 0;
      let theDoor: Vec2 | null = null;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const onPerim = x === x0 || x === x1 || y === y0 || y === y1;
          if (!onPerim) continue;
          const t = map.tiles[y][x];
          if (t === "wall") perimWall++;
          else if (t === "floor") {
            perimFloor++;
            theDoor = { x, y };
          } else {
            throw new Error(`unexpected perimeter tile ${t} at ${x},${y}`);
          }
        }
      }
      expect(perimWall, `${h.id} perimeter wall count`).toBe(15);
      expect(perimFloor, `${h.id} perimeter floor (door) count`).toBe(1);
      expect(theDoor, `${h.id} door`).toEqual(h.door);

      // -- door-gap is `floor`; its exterior neighbour is a passable road -----
      expect(at(h.door)).toBe("floor");
      const ext =
        h.doorSide === "N"
          ? { x: h.door.x, y: h.door.y - 1 }
          : h.doorSide === "S"
            ? { x: h.door.x, y: h.door.y + 1 }
            : h.doorSide === "E"
              ? { x: h.door.x + 1, y: h.door.y }
              : { x: h.door.x - 1, y: h.door.y };
      expect(at(ext), `${h.id} door exterior neighbour is a road path`).toBe("path");

      // -- interior 3×3: exactly 8 floor + exactly 1 bedTile (== h.bed) -------
      let intFloor = 0;
      let intBed = 0;
      let theBed: Vec2 | null = null;
      for (let y = y0 + 1; y <= y1 - 1; y++) {
        for (let x = x0 + 1; x <= x1 - 1; x++) {
          const t = map.tiles[y][x];
          if (t === "floor") intFloor++;
          else if (t === "bedTile") {
            intBed++;
            theBed = { x, y };
          } else {
            throw new Error(`unexpected interior tile ${t} at ${x},${y}`);
          }
        }
      }
      expect(intFloor, `${h.id} interior floor count`).toBe(8);
      expect(intBed, `${h.id} interior bedTile count`).toBe(1);
      expect(theBed, `${h.id} bed`).toEqual(h.bed);

      // -- plot is all soil ---------------------------------------------------
      for (let y = h.plot.y0; y <= h.plot.y1; y++) {
        for (let x = h.plot.x0; x <= h.plot.x1; x++) {
          expect(at({ x, y }), `plot tile ${x},${y}`).toBe("soil");
        }
      }
    }
  });

  it("has exactly 12 bedTiles, zero `building` tiles, and the expected landmark counts", () => {
    let beds = 0;
    let buildings = 0;
    for (let y = 0; y < MAP_HEIGHT; y++)
      for (let x = 0; x < MAP_WIDTH; x++) {
        if (map.tiles[y][x] === "bedTile") beds++;
        if (map.tiles[y][x] === "building") buildings++;
      }
    expect(beds).toBe(12);
    // `building` is retained-but-unused: no tile stamps it anymore.
    expect(buildings).toBe(0);
    const count = (k: string) => map.landmarks.filter((l) => l.kind === k).length;
    expect(count("bed")).toBe(12);
    expect(count("house")).toBe(12);
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

  it("connects every homestead door + the shop + every bed to the tavern via passable tiles", () => {
    const tavern = map.landmarks.find((l) => l.kind === "tavern")!.pos;
    // impassable set: walls/water/building stop the flood; `floor` is passable
    // and must NOT be added (door-gaps + interiors are reachable on purpose).
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
    for (const h of HOMESTEADS) {
      expect(seen.has(key(h.door)), `door ${h.id}`).toBe(true);
      // Interior reachability: the bed inside each room is reachable too.
      expect(seen.has(key(h.bed)), `bed ${h.id}`).toBe(true);
    }
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

  it("every building footprint is actually built and its door is in range", () => {
    // Walkable rooms: a footprint is built out of wall ring + floor interior +
    // the bed/shop overlay cells (NOT the legacy `building` type).
    const built = new Set<TileType>(["wall", "floor", "bedTile", "shopTile"]);
    for (const b of BUILDINGS) {
      expect(b.doorX, `${b.kind} doorX in [x0,x1]`).toBeGreaterThanOrEqual(b.x0);
      expect(b.doorX).toBeLessThanOrEqual(b.x1);
      for (let y = b.y0; y <= b.y1; y++)
        for (let x = b.x0; x <= b.x1; x++)
          expect(built.has(map.tiles[y][x]), `building tile ${x},${y} is ${map.tiles[y][x]}`).toBe(true);
    }
    // Expect 14 buildings: 12 homesteads + shop + tavern.
    expect(BUILDINGS).toHaveLength(14);
  });
});
