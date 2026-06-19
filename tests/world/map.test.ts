import { describe, expect, it } from "vitest";
import type { TileType, Vec2 } from "@contracts/types";
import { MAP_HEIGHT, MAP_WIDTH, OBSERVATION_RADIUS } from "@contracts/types";
import {
  BED_POS,
  BUILDINGS,
  type BuildingFootprint,
  exteriorOf,
  FIELD_RECT,
  generateMap,
  HOMESTEADS,
  PARK,
  SHOP_POS,
} from "../../src/world/map";

const map = generateMap();
const at = (p: Vec2): TileType => map.tiles[p.y][p.x];

/** The single `floor` door-gap on a footprint's perimeter, or null. */
function perimeterDoor(b: BuildingFootprint): Vec2 | null {
  for (let y = b.y0; y <= b.y1; y++)
    for (let x = b.x0; x <= b.x1; x++) {
      const onPerim = x === b.x0 || x === b.x1 || y === b.y0 || y === b.y1;
      if (onPerim && map.tiles[y][x] === "floor") return { x, y };
    }
  return null;
}

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

  it("has fifteen walkable two-room homesteads: full wall ring + 1 door, divider + 1 reachable bed", () => {
    expect(HOMESTEADS).toHaveLength(15);
    for (const h of HOMESTEADS) {
      // Room bounds are SIZE-derived (varied 4×4 / 5×5 / 6×5), never +4.
      const x0 = h.house.x;
      const y0 = h.house.y;
      const x1 = h.house.x + h.size.w - 1;
      const y1 = h.house.y + h.size.h - 1;
      // Perimeter tile count for the room's bounding box.
      const perimTiles = h.size.w * h.size.h - (h.size.w - 2) * (h.size.h - 2);
      const interiorTiles = (h.size.w - 2) * (h.size.h - 2);

      // -- perimeter: full wall ring minus exactly 1 floor (the door-gap) -----
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
      expect(perimWall, `${h.id} perimeter wall count`).toBe(perimTiles - 1);
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

      // -- interior: floor + EXACTLY 1 bedTile + a divider wall (two-room split).
      //    The bed must be REACHABLE from the door through floor cells (BFS), so
      //    the doorway gap in the divider really connects the two rooms.
      void interiorTiles; // multi-room: exact floor count no longer fixed
      let intBed = 0;
      let intWall = 0;
      let theBed: Vec2 | null = null;
      for (let y = y0 + 1; y <= y1 - 1; y++) {
        for (let x = x0 + 1; x <= x1 - 1; x++) {
          const t = map.tiles[y][x];
          if (t === "bedTile") {
            intBed++;
            theBed = { x, y };
          } else if (t === "wall") {
            intWall++;
          } else if (t !== "floor") {
            throw new Error(`unexpected interior tile ${t} at ${x},${y}`);
          }
        }
      }
      expect(intBed, `${h.id} interior bedTile count`).toBe(1);
      expect(theBed, `${h.id} bed`).toEqual(h.bed);
      expect(intWall, `${h.id} has an interior divider wall`).toBeGreaterThan(0);

      // BFS from the door over floor/bed cells must reach the bed.
      const passable = (px: number, py: number): boolean => {
        if (px < x0 || px > x1 || py < y0 || py > y1) return false;
        const t = map.tiles[py][px];
        return t === "floor" || t === "bedTile";
      };
      const seen = new Set<string>([`${h.door.x},${h.door.y}`]);
      const queue: Vec2[] = [{ ...h.door }];
      let bedReached = false;
      while (queue.length > 0) {
        const c = queue.shift() as Vec2;
        if (c.x === h.bed.x && c.y === h.bed.y) {
          bedReached = true;
          break;
        }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = c.x + dx;
          const ny = c.y + dy;
          const k = `${nx},${ny}`;
          if (!seen.has(k) && passable(nx, ny)) {
            seen.add(k);
            queue.push({ x: nx, y: ny });
          }
        }
      }
      expect(bedReached, `${h.id} bed reachable from the door`).toBe(true);

      // -- plot is all soil ---------------------------------------------------
      for (let y = h.plot.y0; y <= h.plot.y1; y++) {
        for (let x = h.plot.x0; x <= h.plot.x1; x++) {
          expect(at({ x, y }), `plot tile ${x},${y}`).toBe("soil");
        }
      }
    }
  });

  it("houses span at least two distinct sizes (organic, hand-built feel)", () => {
    const sizes = new Set(HOMESTEADS.map((h) => `${h.size.w}x${h.size.h}`));
    expect(sizes.size).toBeGreaterThanOrEqual(2);
  });

  it("has exactly 15 bedTiles, zero `building` tiles, and the expected landmark counts", () => {
    let beds = 0;
    let buildings = 0;
    for (let y = 0; y < MAP_HEIGHT; y++)
      for (let x = 0; x < MAP_WIDTH; x++) {
        if (map.tiles[y][x] === "bedTile") beds++;
        if (map.tiles[y][x] === "building") buildings++;
      }
    expect(beds).toBe(15);
    // `building` is retained-but-unused: no tile stamps it anymore.
    expect(buildings).toBe(0);
    const count = (k: string) => map.landmarks.filter((l) => l.kind === k).length;
    expect(count("bed")).toBe(15);
    expect(count("house")).toBe(15);
    expect(count("shop")).toBe(1);
    expect(count("tavern")).toBe(1);
    expect(count("water")).toBeGreaterThanOrEqual(1);
    // Wave 5a — new civic + park landmarks (additive). School emits no landmark.
    expect(count("cafe")).toBe(1);
    expect(count("office")).toBe(1);
    expect(count("park")).toBe(1);
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
    // Every room's door (cafe / office / school doors included) is reached. The
    // door is the single `floor` cell on the footprint perimeter (door-gap).
    for (const b of BUILDINGS) {
      const door = perimeterDoor(b);
      expect(door, `${b.kind} has a door-gap`).not.toBeNull();
      expect(seen.has(key(door!)), `${b.kind} door reachable`).toBe(true);
    }
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

  it("scatters dense multi-kind decor only on grass, within bounds, one per tile", () => {
    // Lush ground cover (trees/bushes/flowers/grass), not the old 16-tree cap.
    expect(map.decor.length).toBeGreaterThan(100);
    const kinds = new Set(map.decor.map((d) => d.kind));
    for (const k of ["tree", "bush", "flower", "grass"] as const) {
      expect(kinds.has(k), `decor includes ${k}`).toBe(true);
    }
    const seen = new Set<string>();
    for (const d of map.decor) {
      expect(["tree", "bush", "flower", "grass"]).toContain(d.kind);
      expect(typeof d.variant, "decor has a numeric variant").toBe("number");
      expect(d.pos.x).toBeGreaterThan(0);
      expect(d.pos.y).toBeGreaterThan(0);
      expect(d.pos.x).toBeLessThan(MAP_WIDTH - 1);
      expect(d.pos.y).toBeLessThan(MAP_HEIGHT - 1);
      expect(map.tiles[d.pos.y][d.pos.x], `decor at ${d.pos.x},${d.pos.y}`).toBe("grass");
      const key = `${d.pos.x},${d.pos.y}`;
      expect(seen.has(key), `one decor per tile at ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("decor scatter is deterministic (zero RNG)", () => {
    const a = generateMap().decor;
    const b = generateMap().decor;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
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
    // Expect 20 rooms: 15 homesteads + shop + tavern + cafe + office + school.
    expect(BUILDINGS).toHaveLength(20);
  });

  it("every building kind is present at least once (typology coverage)", () => {
    const kinds = new Set(BUILDINGS.map((b) => b.kind));
    for (const k of ["house", "shop", "tavern", "cafe", "office", "school"] as const) {
      expect(kinds.has(k), `kind ${k} present`).toBe(true);
    }
  });

  it("each non-house room's door-gap exterior neighbour is a path tile", () => {
    for (const b of BUILDINGS) {
      if (b.kind === "house") continue; // covered per-homestead above
      const door = perimeterDoor(b);
      expect(door, `${b.kind} has a door-gap`).not.toBeNull();
      const ext = exteriorOf(door!, b.doorSide);
      expect(at(ext), `${b.kind} door exterior is a road path`).toBe("path");
    }
  });

  it("the park is a walkable green region with an inner pond and ≥1 bench inside", () => {
    // Count tile types inside the park region.
    let grass = 0;
    let water = 0;
    for (let y = PARK.y0; y <= PARK.y1; y++)
      for (let x = PARK.x0; x <= PARK.x1; x++) {
        const t = map.tiles[y][x];
        if (t === "grass") grass++;
        else if (t === "water") water++;
      }
    expect(grass, "park has walkable grass").toBeGreaterThan(0);
    expect(water, "park has an inner pond").toBeGreaterThanOrEqual(4); // ≥4-wide pond
    // ≥1 bench WorldObject sits inside the park region.
    const benchesInPark = map.objects.filter(
      (o) =>
        o.kind === "bench" &&
        o.pos.x >= PARK.x0 && o.pos.x <= PARK.x1 &&
        o.pos.y >= PARK.y0 && o.pos.y <= PARK.y1,
    );
    expect(benchesInPark.length, "≥1 bench inside the park").toBeGreaterThanOrEqual(1);
    // ≥1 decor tree sits inside the park region.
    const treesInPark = map.decor.filter(
      (d) =>
        d.pos.x >= PARK.x0 && d.pos.x <= PARK.x1 &&
        d.pos.y >= PARK.y0 && d.pos.y <= PARK.y1,
    );
    expect(treesInPark.length, "≥1 tree inside the park").toBeGreaterThanOrEqual(1);
  });
});
