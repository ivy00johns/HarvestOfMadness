/**
 * Walkable-interiors proof (Wave-1 workstream A feature tests).
 *
 * Proves the new "wall ring + single floor door-gap + walkable floor interior"
 * homestead/commons model end-to-end: door-only entry and interior routing come
 * for free from tile-type-driven passability (Tile.ts → World.isPassable → A*),
 * with no portal concept and no pathfinding change.
 *
 * Every coordinate here is structure-derived (HOMESTEADS / BUILDINGS / landmarks
 * / MAP_WIDTH / MAP_HEIGHT / exports) so the tests follow any relayout.
 */
import { describe, expect, it } from "vitest";
import type { TileType, Vec2 } from "@contracts/types";
import { MAP_HEIGHT, MAP_WIDTH } from "@contracts/types";
import { World } from "../../src/world/World";
import { BUILDINGS, generateMap, HOMESTEADS } from "../../src/world/map";
import { PERSONAS } from "../../src/agents/personas";
import { isTypePassable } from "../../src/world/Tile";

const map = generateMap();
const world = new World();
const at = (p: Vec2): TileType => map.tiles[p.y][p.x];
const key = (p: Vec2) => `${p.x},${p.y}`;

/** Tavern door landmark (the floor door-gap of the central tavern room). */
const TAVERN = { ...map.landmarks.find((l) => l.kind === "tavern")!.pos };

/** Flood fill over passable tiles from a start, returning the visited set. */
function floodPassable(start: Vec2): Set<string> {
  const seen = new Set<string>([key(start)]);
  const queue: Vec2[] = [start];
  while (queue.length) {
    const p = queue.shift()!;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const n = { x: p.x + dx, y: p.y + dy };
      if (n.x < 0 || n.y < 0 || n.x >= MAP_WIDTH || n.y >= MAP_HEIGHT) continue;
      if (seen.has(key(n)) || !isTypePassable(map.tiles[n.y][n.x])) continue;
      seen.add(key(n));
      queue.push(n);
    }
  }
  return seen;
}

describe("walkable interiors — door-gap structure", () => {
  it("each homestead perimeter is a full wall ring + 1 floor door-gap (== h.door)", () => {
    for (const h of HOMESTEADS) {
      // SIZE-derived bounds (varied 4×4 / 5×5 / 6×5 rooms), never +4.
      const x0 = h.house.x;
      const y0 = h.house.y;
      const x1 = h.house.x + h.size.w - 1;
      const y1 = h.house.y + h.size.h - 1;
      const perimTiles = h.size.w * h.size.h - (h.size.w - 2) * (h.size.h - 2);
      let wall = 0;
      let floor = 0;
      const floorCells: Vec2[] = [];
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (!(x === x0 || x === x1 || y === y0 || y === y1)) continue;
          const t = map.tiles[y][x];
          if (t === "wall") wall++;
          else if (t === "floor") {
            floor++;
            floorCells.push({ x, y });
          }
        }
      }
      expect(wall, `${h.id} perimeter wall`).toBe(perimTiles - 1);
      expect(floor, `${h.id} perimeter floor (door-gap)`).toBe(1);
      expect(floorCells[0], `${h.id} door-gap is h.door`).toEqual(h.door);
    }
  });

  it("every door-gap is a passable `floor` tile, and every persona start is passable", () => {
    for (const h of HOMESTEADS) {
      expect(at(h.door), `${h.id} door type`).toBe("floor");
      expect(world.isPassable(h.door.x, h.door.y), `${h.id} door passable`).toBe(true);
    }
    for (const p of PERSONAS) {
      expect(
        world.isPassable(p.start.x, p.start.y),
        `${p.id} start ${JSON.stringify(p.start)} must be passable`,
      ).toBe(true);
    }
  });
});

describe("walkable interiors — reachability", () => {
  it("a single flood-fill from the tavern reaches every homestead bed (interior routing)", () => {
    const reached = floodPassable(TAVERN);
    for (const h of HOMESTEADS) {
      expect(reached.has(key(h.bed)), `bed of ${h.id} reachable from tavern`).toBe(true);
    }
  });

  it("A* finds a path from the spine into each room ending exactly on the bed", () => {
    // The horizontal spine is open path; route from a spine tile into each room.
    const spineStart: Vec2 = { x: 4, y: 20 };
    for (const h of HOMESTEADS) {
      const path = world.findPath(spineStart, h.bed);
      expect(path, `A* spine→${h.id} bed`).not.toBeNull();
      const last = path![path!.length - 1];
      expect(last, `${h.id} path ends on the bed`).toEqual(h.bed);
    }
  });

  it("the bed inside a sealed-but-door-gapped room is unreachable when the door is walled shut", () => {
    // Sanity: passability really is door-only. Rebuild a map, wall the first
    // homestead's door, and confirm its interior becomes unreachable — proving
    // the door-gap is the sole opening.
    const m = generateMap();
    const h = HOMESTEADS[0];
    m.tiles[h.door.y][h.door.x] = "wall";
    const sealed = new World(m);
    expect(sealed.findPath({ x: 4, y: 20 }, h.bed)).toBeNull();
  });
});

describe("walkable interiors — capacity + retired type", () => {
  it("the tavern interior has ≥6 walkable floor tiles (party convergence room)", () => {
    const tav = MAP_BUILDING("tavern");
    let floor = 0;
    for (let y = tav.y0 + 1; y <= tav.y1 - 1; y++)
      for (let x = tav.x0 + 1; x <= tav.x1 - 1; x++)
        if (map.tiles[y][x] === "floor" && world.isPassable(x, y)) floor++;
    expect(floor).toBeGreaterThanOrEqual(6);
  });

  it("no `building` tiles remain anywhere on the map (retired type)", () => {
    let buildings = 0;
    for (let y = 0; y < MAP_HEIGHT; y++)
      for (let x = 0; x < MAP_WIDTH; x++)
        if (map.tiles[y][x] === "building") buildings++;
    expect(buildings).toBe(0);
  });

  it("`floor` is a passable, non-tillable tile type", () => {
    expect(isTypePassable("floor")).toBe(true);
    // till() rejects floor with a readable reason mentioning the type.
    const r = new World().till({ ...HOMESTEADS[0].door });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("floor");
  });
});

/** Locate a BUILDINGS footprint by kind. */
function MAP_BUILDING(kind: "house" | "shop" | "tavern") {
  return BUILDINGS.find((b) => b.kind === kind)!;
}
