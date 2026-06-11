/**
 * Code-generated 24x18 tilemap (no Tiled). Mission §12/§13: the map is data
 * produced in code so the game runs with zero asset files.
 *
 * Layout (x right, y down, 0-indexed):
 * - wall border all around
 * - farmhouse (building) near top-left, one bedTile in its bottom row (door/bed)
 * - pond (water) 3x4 mid-top
 * - shop (building) near top-right, one shopTile entrance in its bottom row
 * - path row connecting house <-> shop <-> farm field
 * - 8x6 tillable soil field center/south
 * - everything else grass
 */
import type { Landmark, TileType } from "@contracts/types";
import { MAP_HEIGHT, MAP_WIDTH } from "@contracts/types";

export interface MapData {
  width: number;
  height: number;
  /** tiles[y][x] */
  tiles: TileType[][];
  landmarks: Landmark[];
}

/** Inclusive rect fill helper. */
function fillRect(
  tiles: TileType[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  type: TileType,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      tiles[y][x] = type;
    }
  }
}

export const BED_POS = { x: 3, y: 4 };
export const SHOP_POS = { x: 19, y: 4 };
/** Path tile in front of the farmhouse door — navigable "house" landmark. */
export const HOUSE_POS = { x: 3, y: 5 };
/** A pond-edge water tile (south edge, center). */
export const WATER_POS = { x: 8, y: 5 };

/** Bounds of the tillable soil field (inclusive), exported for demos/tests. */
export const FIELD_RECT = { x0: 8, y0: 8, x1: 15, y1: 13 };

export function generateMap(): MapData {
  const tiles: TileType[][] = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    tiles.push(new Array<TileType>(MAP_WIDTH).fill("grass"));
  }

  // Wall border
  fillRect(tiles, 0, 0, MAP_WIDTH - 1, 0, "wall");
  fillRect(tiles, 0, MAP_HEIGHT - 1, MAP_WIDTH - 1, MAP_HEIGHT - 1, "wall");
  fillRect(tiles, 0, 0, 0, MAP_HEIGHT - 1, "wall");
  fillRect(tiles, MAP_WIDTH - 1, 0, MAP_WIDTH - 1, MAP_HEIGHT - 1, "wall");

  // Farmhouse (top-left): building footprint with a bedTile "door" in the
  // bottom row so the bed is reachable from the path below.
  fillRect(tiles, 2, 2, 5, 4, "building");
  tiles[BED_POS.y][BED_POS.x] = "bedTile";

  // Pond: 3 wide x 4 tall
  fillRect(tiles, 7, 2, 9, 5, "water");

  // Shop (top-right): building footprint with a shopTile entrance.
  fillRect(tiles, 18, 2, 21, 4, "building");
  tiles[SHOP_POS.y][SHOP_POS.x] = "shopTile";

  // Path: main road at y=6 plus stubs up to the house/shop doors and down
  // to the farm field.
  fillRect(tiles, 3, 6, 20, 6, "path");
  tiles[5][3] = "path"; // house door stub (below bedTile)
  tiles[5][19] = "path"; // shop door stub (below shopTile)
  tiles[7][11] = "path"; // field stub

  // Tillable soil field 8x6 center/south
  fillRect(tiles, FIELD_RECT.x0, FIELD_RECT.y0, FIELD_RECT.x1, FIELD_RECT.y1, "soil");

  const landmarks: Landmark[] = [
    { kind: "bed", pos: { ...BED_POS } },
    { kind: "shop", pos: { ...SHOP_POS } },
    { kind: "house", pos: { ...HOUSE_POS } },
    { kind: "water", pos: { ...WATER_POS } },
  ];

  return { width: MAP_WIDTH, height: MAP_HEIGHT, tiles, landmarks };
}
