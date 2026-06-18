import { describe, expect, it } from "vitest";
import { MAP_WIDTH } from "@contracts/types";
import { findPath, type PathGrid } from "../../src/world/Pathfinding";
import { World } from "../../src/world/World";
import { WATER_POS } from "../../src/world/map";

function freshWorld(): World {
  return new World();
}

// The horizontal road spine (path) is open across the map's interior.
const SPINE_Y = 20;
// Tiles flanking the pond on its centre row (grass either side of the water).
const POND_W = { x: WATER_POS.x - 1, y: WATER_POS.y + 1 };
const POND_E = { x: WATER_POS.x + 4, y: WATER_POS.y + 1 };

describe("Pathfinding (A*, 4-neighbour, Manhattan)", () => {
  it("finds a straight path between open tiles", () => {
    const world = freshWorld();
    // The y=20 spine is open path from x=1..62 between the vertical roads.
    const path = world.findPath({ x: 4, y: SPINE_Y }, { x: 10, y: SPINE_Y });
    expect(path).not.toBeNull();
    expect(path![0]).toEqual({ x: 4, y: SPINE_Y });
    expect(path![path!.length - 1]).toEqual({ x: 10, y: SPINE_Y });
    expect(path!.length).toBe(7); // optimal: start + 6 steps
  });

  it("returns a single-element path for from === to", () => {
    const world = freshWorld();
    expect(world.findPath({ x: 4, y: SPINE_Y }, { x: 4, y: SPINE_Y })).toEqual([
      { x: 4, y: SPINE_Y },
    ]);
  });

  it("returns null when the target is impassable (water)", () => {
    const world = freshWorld();
    expect(world.getTile(WATER_POS.x, WATER_POS.y)!.type).toBe("water"); // pond corner
    expect(world.findPath({ x: 4, y: SPINE_Y }, { ...WATER_POS })).toBeNull();
  });

  it("returns null when the target is walled off (unreachable)", () => {
    // 5x5 grid with the center cell enclosed by walls.
    const blocked = new Set(["1,1", "2,1", "3,1", "1,2", "3,2", "1,3", "2,3", "3,3"]);
    const grid: PathGrid = {
      width: 5,
      height: 5,
      isPassable: (x, y) => !blocked.has(`${x},${y}`),
    };
    expect(findPath(grid, { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
  });

  it("walks around the pond instead of through it", () => {
    const world = freshWorld();
    // POND_W and POND_E are grass either side of the 4x4 pond.
    expect(world.getTile(POND_W.x, POND_W.y)!.type).toBe("grass");
    expect(world.getTile(POND_E.x, POND_E.y)!.type).toBe("grass");
    const path = world.findPath({ ...POND_W }, { ...POND_E });
    expect(path).not.toBeNull();
    for (const p of path!) {
      expect(world.isPassable(p.x, p.y)).toBe(true);
      expect(world.getTile(p.x, p.y)!.type).not.toBe("water");
    }
    // Detour is forced: longer than the Manhattan distance of 5.
    expect(path!.length).toBeGreaterThan(6);
    // Every step is a 4-neighbour move.
    for (let i = 1; i < path!.length; i++) {
      const dx = Math.abs(path![i].x - path![i - 1].x);
      const dy = Math.abs(path![i].y - path![i - 1].y);
      expect(dx + dy).toBe(1);
    }
  });

  it("returns null for out-of-bounds endpoints", () => {
    const world = freshWorld();
    expect(world.findPath({ x: -1, y: 0 }, { x: 4, y: SPINE_Y })).toBeNull();
    expect(world.findPath({ x: 4, y: SPINE_Y }, { x: MAP_WIDTH + 35, y: SPINE_Y })).toBeNull();
  });
});
