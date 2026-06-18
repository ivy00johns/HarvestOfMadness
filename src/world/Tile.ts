/**
 * Tile helpers — pure functions over the contract Tile shape.
 * No Phaser imports (used by headless tests).
 */
import type { Tile, TileType, Vec2 } from "@contracts/types";

/** Tile types an agent can stand on / walk through. */
const PASSABLE_TYPES: ReadonlySet<TileType> = new Set([
  "grass",
  "path",
  "tilled",
  "soil",
  "floor", // v3 — walkable indoor floor (door-gap + room interiors)
  "bedTile",
  "shopTile",
]);

/** Tile types that till() accepts. `floor` is NOT tillable (till(floor) rejects). */
const TILLABLE_TYPES: ReadonlySet<TileType> = new Set(["grass", "soil"]);

export function makeTile(x: number, y: number, type: TileType): Tile {
  return { x, y, type };
}

export function isTypePassable(type: TileType): boolean {
  return PASSABLE_TYPES.has(type);
}

export function isTypeTillable(type: TileType): boolean {
  return TILLABLE_TYPES.has(type);
}

export function posKey(p: Vec2): string {
  return `${p.x},${p.y}`;
}
