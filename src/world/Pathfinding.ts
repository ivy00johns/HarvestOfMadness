/**
 * A* pathfinding — 4-neighbour grid, Manhattan heuristic. Pure logic.
 * Returns the full path INCLUDING the start and goal tiles, or null when
 * unreachable. The start tile itself is not required to be passable (an
 * agent may be standing on it); every subsequent tile must be.
 */
import type { Vec2 } from "@contracts/types";

export interface PathGrid {
  width: number;
  height: number;
  isPassable(x: number, y: number): boolean;
}

const DIRS: ReadonlyArray<Vec2> = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

function manhattan(a: Vec2, b: Vec2): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function findPath(grid: PathGrid, from: Vec2, to: Vec2): Vec2[] | null {
  const inBounds = (p: Vec2): boolean =>
    p.x >= 0 && p.y >= 0 && p.x < grid.width && p.y < grid.height;

  if (!inBounds(from) || !inBounds(to)) return null;
  if (from.x === to.x && from.y === to.y) return [{ ...from }];
  if (!grid.isPassable(to.x, to.y)) return null;

  const key = (x: number, y: number): number => y * grid.width + x;
  const startKey = key(from.x, from.y);
  const goalKey = key(to.x, to.y);

  const gScore = new Map<number, number>([[startKey, 0]]);
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();
  // Small map (24x18) — a sorted-insert array open list is plenty.
  const open: { k: number; f: number; pos: Vec2 }[] = [
    { k: startKey, f: manhattan(from, to), pos: { ...from } },
  ];

  while (open.length > 0) {
    // Pop lowest f.
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[best].f) best = i;
    }
    const current = open.splice(best, 1)[0];
    if (current.k === goalKey) {
      // Reconstruct.
      const path: Vec2[] = [];
      let k: number | undefined = current.k;
      while (k !== undefined) {
        path.push({ x: k % grid.width, y: Math.floor(k / grid.width) });
        k = cameFrom.get(k);
      }
      path.reverse();
      return path;
    }
    if (closed.has(current.k)) continue;
    closed.add(current.k);

    for (const d of DIRS) {
      const nx = current.pos.x + d.x;
      const ny = current.pos.y + d.y;
      const np = { x: nx, y: ny };
      if (!inBounds(np) || !grid.isPassable(nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const tentative = (gScore.get(current.k) ?? Infinity) + 1;
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, tentative);
        cameFrom.set(nk, current.k);
        open.push({ k: nk, f: tentative + manhattan(np, to), pos: np });
      }
    }
  }
  return null;
}
