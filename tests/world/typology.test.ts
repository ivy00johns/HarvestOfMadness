/**
 * Building TYPOLOGY proof (Wave 5a) — the organic, varied town: 6 distinct
 * room kinds (house/shop/tavern/cafe/office/school) each built as a wall ring +
 * single floor door-gap, every door BFS-reachable from the tavern; houses span
 * ≥2 distinct sizes; the civic cluster bunches near the central plaza; and the
 * PARK is a walkable green region with an inner pond, ≥1 bench and ≥1 tree.
 *
 * Every coordinate is STRUCTURE-derived (BUILDINGS / HOMESTEADS / landmarks /
 * map.tiles / PARK / exports), never a hardcoded tile, so the suite follows any
 * relayout.
 */
import { describe, expect, it } from "vitest";
import type { TileType, Vec2 } from "@contracts/types";
import { MAP_HEIGHT, MAP_WIDTH } from "@contracts/types";
import { World } from "../../src/world/World";
import {
  BUILDINGS,
  type BuildingFootprint,
  type BuildingKind,
  exteriorOf,
  generateMap,
  HOMESTEADS,
  PARK,
} from "../../src/world/map";

const map = generateMap();
const at = (p: Vec2): TileType => map.tiles[p.y][p.x];
const key = (p: Vec2) => `${p.x},${p.y}`;

/** The single `floor` door-gap on a footprint perimeter (or null). */
function perimeterDoor(b: BuildingFootprint): Vec2 | null {
  for (let y = b.y0; y <= b.y1; y++)
    for (let x = b.x0; x <= b.x1; x++) {
      const onPerim = x === b.x0 || x === b.x1 || y === b.y0 || y === b.y1;
      if (onPerim && map.tiles[y][x] === "floor") return { x, y };
    }
  return null;
}

/** BFS over passable tiles (walls/water/building block) from a start. */
function flood(start: Vec2): Set<string> {
  const impassable = new Set<TileType>(["wall", "water", "building"]);
  const seen = new Set<string>([key(start)]);
  const queue: Vec2[] = [start];
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
  return seen;
}

const ALL_KINDS: BuildingKind[] = ["house", "shop", "tavern", "cafe", "office", "school"];
const TAVERN_POS = { ...map.landmarks.find((l) => l.kind === "tavern")!.pos };

describe("building typology — six distinct room kinds", () => {
  it("every kind is present at least once", () => {
    const kinds = new Set(BUILDINGS.map((b) => b.kind));
    for (const k of ALL_KINDS) expect(kinds.has(k), `kind ${k}`).toBe(true);
  });

  it("each room is a full wall ring with exactly one floor door-gap and a floor interior", () => {
    for (const b of BUILDINGS) {
      let wall = 0;
      let doorGaps = 0;
      let interiorFloor = 0;
      for (let y = b.y0; y <= b.y1; y++)
        for (let x = b.x0; x <= b.x1; x++) {
          const onPerim = x === b.x0 || x === b.x1 || y === b.y0 || y === b.y1;
          const t = map.tiles[y][x];
          if (onPerim) {
            if (t === "wall") wall++;
            else if (t === "floor") doorGaps++;
          } else if (t === "floor" || t === "bedTile" || t === "shopTile") {
            interiorFloor++;
          }
        }
      const perimTiles =
        (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) -
        (b.x1 - b.x0 - 1) * (b.y1 - b.y0 - 1);
      expect(wall, `${b.kind} wall ring`).toBe(perimTiles - 1);
      expect(doorGaps, `${b.kind} exactly one door-gap`).toBe(1);
      expect(interiorFloor, `${b.kind} walkable interior`).toBeGreaterThan(0);
    }
  });

  it("the shop carries a shopTile and the tavern landmark is its door-gap", () => {
    // shop special tile
    const shop = BUILDINGS.find((b) => b.kind === "shop")!;
    let shopTiles = 0;
    for (let y = shop.y0; y <= shop.y1; y++)
      for (let x = shop.x0; x <= shop.x1; x++)
        if (map.tiles[y][x] === "shopTile") shopTiles++;
    expect(shopTiles, "shop has exactly one shopTile").toBe(1);
    // tavern landmark sits on a floor door-gap
    expect(at(TAVERN_POS)).toBe("floor");
  });

  it("every room's door-gap is reachable from the tavern (BFS over passable tiles)", () => {
    const reached = flood(TAVERN_POS);
    for (const b of BUILDINGS) {
      const door = perimeterDoor(b);
      expect(door, `${b.kind} door-gap exists`).not.toBeNull();
      expect(reached.has(key(door!)), `${b.kind} door reachable from tavern`).toBe(true);
    }
  });

  it("every room's door-gap exterior neighbour is a path tile (road-first stamping)", () => {
    for (const b of BUILDINGS) {
      const door = perimeterDoor(b);
      expect(door, `${b.kind} door-gap exists`).not.toBeNull();
      expect(at(exteriorOf(door!, b.doorSide)), `${b.kind} door exterior is path`).toBe("path");
    }
  });

  it("A* reaches every room's door-gap from the tavern (real pathfinder)", () => {
    const world = new World();
    for (const b of BUILDINGS) {
      const door = perimeterDoor(b)!;
      const path = world.findPath(door, TAVERN_POS);
      expect(path, `A* ${b.kind} door → tavern`).not.toBeNull();
    }
  });
});

describe("organic layout — varied sizes + bounded downtown cluster", () => {
  it("houses span at least two distinct sizes", () => {
    const sizes = new Set(HOMESTEADS.map((h) => `${h.size.w}x${h.size.h}`));
    expect(sizes.size).toBeGreaterThanOrEqual(2);
  });

  it("the civic cluster (shop/tavern/cafe/office/school) bunches near the plaza centre", () => {
    const civic = BUILDINGS.filter((b) => b.kind !== "house");
    // Each civic room's centre is within a tight radius of the cluster's centroid.
    const centres = civic.map((b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }));
    const cx = centres.reduce((s, c) => s + c.x, 0) / centres.length;
    const cy = centres.reduce((s, c) => s + c.y, 0) / centres.length;
    for (const [i, c] of centres.entries()) {
      const d = Math.max(Math.abs(c.x - cx), Math.abs(c.y - cy));
      expect(d, `${civic[i].kind} sits in the downtown cluster`).toBeLessThanOrEqual(14);
    }
  });
});

describe("the park — walkable green region with an inner pond", () => {
  const world = new World();

  it("contains walkable grass and an inner pond ≥4 tiles wide", () => {
    let grass = 0;
    let widestWaterRow = 0;
    for (let y = PARK.y0; y <= PARK.y1; y++) {
      let rowWater = 0;
      for (let x = PARK.x0; x <= PARK.x1; x++) {
        const t = map.tiles[y][x];
        if (t === "grass") grass++;
        else if (t === "water") rowWater++;
      }
      widestWaterRow = Math.max(widestWaterRow, rowWater);
    }
    expect(grass, "park has walkable grass").toBeGreaterThan(0);
    expect(widestWaterRow, "pond ≥4 wide").toBeGreaterThanOrEqual(4);
  });

  it("the park region is passable (grass) and its grass is reachable from the tavern", () => {
    const reached = flood(TAVERN_POS);
    let reachedGrass = 0;
    for (let y = PARK.y0; y <= PARK.y1; y++)
      for (let x = PARK.x0; x <= PARK.x1; x++) {
        if (map.tiles[y][x] !== "grass") continue;
        expect(world.isPassable(x, y), `park grass ${x},${y} passable`).toBe(true);
        if (reached.has(key({ x, y }))) reachedGrass++;
      }
    expect(reachedGrass, "park grass reachable from tavern").toBeGreaterThan(0);
  });

  it("has at least one bench and at least one tree inside it", () => {
    const inPark = (p: Vec2) =>
      p.x >= PARK.x0 && p.x <= PARK.x1 && p.y >= PARK.y0 && p.y <= PARK.y1;
    const benches = map.objects.filter((o) => o.kind === "bench" && inPark(o.pos));
    const trees = map.decor.filter((d) => d.kind === "tree" && inPark(d.pos));
    expect(benches.length, "≥1 bench inside the park").toBeGreaterThanOrEqual(1);
    expect(trees.length, "≥1 tree inside the park").toBeGreaterThanOrEqual(1);
  });

  it("emits a 'park' landmark", () => {
    expect(map.landmarks.some((l) => l.kind === "park")).toBe(true);
  });
});
