/**
 * World — implements the contract WorldApi verbatim. Pure logic, no Phaser.
 *
 * Farm mutations enforce TILE-LEVEL preconditions only and return
 * {ok, reason} — energy/inventory/position checks belong to the W2
 * ActionExecutor (contracts/README.md rule 1).
 */
import type {
  ActionResult,
  CropKind,
  Landmark,
  Tile,
  TimeState,
  Vec2,
  WorldApi,
} from "@contracts/types";
import { CROPS } from "@contracts/types";
import { Grid } from "./Grid";
import { findPath as aStar } from "./Pathfinding";
import { TimeSystem } from "./TimeSystem";
import { buildBuyPrices, buildSellPrices } from "./Economy";
import { generateMap, type MapData } from "./map";
import { isTypeTillable } from "./Tile";

/**
 * Internal change feed (NOT part of the contract): WorldScene subscribes to
 * redraw dirty tiles. `tiles === null` means "everything may have changed"
 * (e.g. after advanceDay).
 */
export type WorldChangeListener = (tiles: Vec2[] | null) => void;

export class World implements WorldApi {
  readonly grid: Grid;
  readonly timeSystem: TimeSystem;
  private readonly mapLandmarks: Landmark[];
  private readonly buyTable = buildBuyPrices();
  private readonly sellTable = buildSellPrices();
  private readonly changeListeners = new Set<WorldChangeListener>();

  constructor(map: MapData = generateMap(), timeSystem = new TimeSystem()) {
    this.grid = new Grid(map);
    this.timeSystem = timeSystem;
    this.mapLandmarks = map.landmarks;
  }

  get width(): number {
    return this.grid.width;
  }

  get height(): number {
    return this.grid.height;
  }

  getTile(x: number, y: number): Tile | null {
    return this.grid.getTile(x, y);
  }

  tilesInRadius(pos: Vec2, r: number): Tile[] {
    return this.grid.tilesInRadius(pos, r);
  }

  isPassable(x: number, y: number): boolean {
    return this.grid.isPassable(x, y);
  }

  /** 4-neighbour adjacency or same tile. */
  isAdjacent(a: Vec2, b: Vec2): boolean {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 1;
  }

  findPath(from: Vec2, to: Vec2): Vec2[] | null {
    return aStar(this.grid, from, to);
  }

  landmarks(): Landmark[] {
    return this.mapLandmarks.map((l) => ({ kind: l.kind, pos: { ...l.pos } }));
  }

  time(): TimeState {
    return this.timeSystem.state();
  }

  /**
   * SLEEP semantics (world-owned): next morning; +1 stage for every watered
   * crop; recompute ready; reset watered=false on ALL crops. Energy restore
   * is the executor's job.
   */
  advanceDay(): void {
    this.timeSystem.advanceDay();
    for (const tile of this.grid.cropTiles()) {
      const crop = tile.crop!;
      if (crop.watered) crop.stage++;
      crop.ready = crop.stage >= CROPS[crop.kind].days;
      crop.watered = false;
    }
    this.emitChange(null);
  }

  till(p: Vec2): ActionResult {
    const tile = this.grid.getTile(p.x, p.y);
    if (!tile) return reject(`tile (${p.x},${p.y}) is outside the map`);
    if (tile.type === "tilled") {
      return reject(`tile (${p.x},${p.y}) is already tilled`);
    }
    if (!isTypeTillable(tile.type)) {
      return reject(`tile (${p.x},${p.y}) is ${tile.type}, not tillable`);
    }
    tile.type = "tilled";
    this.emitChange([{ ...p }]);
    return { ok: true };
  }

  plant(p: Vec2, kind: CropKind): ActionResult {
    const tile = this.grid.getTile(p.x, p.y);
    if (!tile) return reject(`tile (${p.x},${p.y}) is outside the map`);
    if (tile.type !== "tilled") {
      return reject(`tile (${p.x},${p.y}) is ${tile.type}, not tilled soil`);
    }
    if (tile.crop) {
      return reject(
        `tile (${p.x},${p.y}) already has a ${tile.crop.kind} growing`,
      );
    }
    if (!CROPS[kind]) {
      return reject(`unknown crop kind "${kind}"`);
    }
    tile.crop = { kind, stage: 0, watered: false, ready: false };
    this.emitChange([{ ...p }]);
    return { ok: true };
  }

  water(p: Vec2): ActionResult {
    const tile = this.grid.getTile(p.x, p.y);
    if (!tile) return reject(`tile (${p.x},${p.y}) is outside the map`);
    if (!tile.crop) {
      return reject(`tile (${p.x},${p.y}) has no crop to water`);
    }
    if (tile.crop.watered) {
      return reject(`crop at (${p.x},${p.y}) is already watered today`);
    }
    tile.crop.watered = true;
    this.emitChange([{ ...p }]);
    return { ok: true };
  }

  harvest(p: Vec2): ActionResult & { itemId?: string } {
    const tile = this.grid.getTile(p.x, p.y);
    if (!tile) return reject(`tile (${p.x},${p.y}) is outside the map`);
    if (!tile.crop) {
      return reject(`tile (${p.x},${p.y}) has no crop to harvest`);
    }
    if (!tile.crop.ready) {
      return reject(
        `${tile.crop.kind} at (${p.x},${p.y}) is not ready ` +
          `(stage ${tile.crop.stage}/${CROPS[tile.crop.kind].days})`,
      );
    }
    const itemId = `crop:${tile.crop.kind}`;
    delete tile.crop; // tile stays tilled
    this.emitChange([{ ...p }]);
    return { ok: true, itemId };
  }

  sellPrices(): Record<string, number> {
    return { ...this.sellTable };
  }

  buyPrices(): Record<string, number> {
    return { ...this.buyTable };
  }

  // -- internal (not part of WorldApi) ------------------------------------

  /** Subscribe to tile mutations (renderer hook). Returns unsubscribe. */
  onChange(cb: WorldChangeListener): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private emitChange(tiles: Vec2[] | null): void {
    for (const cb of this.changeListeners) cb(tiles);
  }
}

function reject(reason: string): ActionResult {
  return { ok: false, reason };
}
