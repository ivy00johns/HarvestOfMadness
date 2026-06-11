/**
 * Grid — tile storage + spatial queries. Pure logic, no Phaser.
 */
import type { Tile, Vec2 } from "@contracts/types";
import type { MapData } from "./map";
import { isTypePassable, makeTile } from "./Tile";

export class Grid {
  readonly width: number;
  readonly height: number;
  private readonly tiles: Tile[][];

  constructor(map: MapData) {
    this.width = map.width;
    this.height = map.height;
    this.tiles = map.tiles.map((row, y) =>
      row.map((type, x) => makeTile(x, y, type)),
    );
  }

  inBounds(x: number, y: number): boolean {
    return (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < this.width &&
      y < this.height
    );
  }

  getTile(x: number, y: number): Tile | null {
    return this.inBounds(x, y) ? this.tiles[y][x] : null;
  }

  /** All tiles within Chebyshev radius r of pos, clipped to the map. */
  tilesInRadius(pos: Vec2, r: number): Tile[] {
    const out: Tile[] = [];
    const x0 = Math.max(0, pos.x - r);
    const y0 = Math.max(0, pos.y - r);
    const x1 = Math.min(this.width - 1, pos.x + r);
    const y1 = Math.min(this.height - 1, pos.y + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        out.push(this.tiles[y][x]);
      }
    }
    return out;
  }

  isPassable(x: number, y: number): boolean {
    const tile = this.getTile(x, y);
    return tile !== null && isTypePassable(tile.type);
  }

  /** Every tile that currently carries a crop. */
  cropTiles(): Tile[] {
    const out: Tile[] = [];
    for (const row of this.tiles) {
      for (const tile of row) {
        if (tile.crop) out.push(tile);
      }
    }
    return out;
  }
}
