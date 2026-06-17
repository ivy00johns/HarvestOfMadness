import { describe, expect, it } from "vitest";
import { findPath, type PathGrid } from "../../src/world/Pathfinding";
import { World } from "../../src/world/World";

function freshWorld(): World {
  return new World();
}

describe("Pathfinding (A*, 4-neighbour, Manhattan)", () => {
  it("finds a straight path between open tiles", () => {
    const world = freshWorld();
    // Path row y=6 is open from x=3..20.
    const path = world.findPath({ x: 4, y: 6 }, { x: 10, y: 6 });
    expect(path).not.toBeNull();
    expect(path![0]).toEqual({ x: 4, y: 6 });
    expect(path![path!.length - 1]).toEqual({ x: 10, y: 6 });
    expect(path!.length).toBe(7); // optimal: start + 6 steps
  });

  it("returns a single-element path for from === to", () => {
    const world = freshWorld();
    expect(world.findPath({ x: 4, y: 6 }, { x: 4, y: 6 })).toEqual([
      { x: 4, y: 6 },
    ]);
  });

  it("returns null when the target is impassable (water)", () => {
    const world = freshWorld();
    expect(world.getTile(31, 10)!.type).toBe("water"); // inside the pond (x:30-33, y:8-11)
    expect(world.findPath({ x: 4, y: 6 }, { x: 31, y: 10 })).toBeNull();
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
    // (29,10) and (34,10) are grass either side of the 4x4 pond (x30..33, y8..11).
    const path = world.findPath({ x: 29, y: 10 }, { x: 34, y: 10 });
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
    expect(world.findPath({ x: -1, y: 0 }, { x: 4, y: 6 })).toBeNull();
    expect(world.findPath({ x: 4, y: 6 }, { x: 99, y: 6 })).toBeNull();
  });
});
