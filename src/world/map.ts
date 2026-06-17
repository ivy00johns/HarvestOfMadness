/**
 * Code-generated 48x32 town (no Tiled). Six homesteads — each a 3x3 house with
 * its own bed and an adjacent soil plot — ring a central commons (shop, tavern,
 * pond). A horizontal road at y=16 spans the interior; every door opens directly
 * onto it (doors sit at y=15 or y=17), so the whole town is connected with no
 * path stubs. Three vertical roads (x=12/24/36) add cross-town travel.
 *
 * Divergence is spatial: each agent starts at its own door and the LLM/mock both
 * act on the NEAREST crop/tile/bed, so agents tend their own plots and sleep in
 * their own beds without any ownership rules.
 */
import type { Landmark, TileType, Vec2 } from "@contracts/types";
import { MAP_HEIGHT, MAP_WIDTH } from "@contracts/types";

export interface DecorItem {
  kind: "tree";
  pos: Vec2;
}

export interface MapData {
  width: number;
  height: number;
  /** tiles[y][x] */
  tiles: TileType[][];
  landmarks: Landmark[];
  /** non-interactive scenery (renderer only) */
  decor: DecorItem[];
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

interface HomesteadSpec {
  /** persona id (matches src/agents/personas.ts) */
  id: string;
  /** top-left tile of the 3x3 house building */
  house: Vec2;
  /** bedTile (inside the house footprint) */
  bed: Vec2;
  /** path tile in front of the bed — the persona's start (at y=15 or y=17) */
  door: Vec2;
  /** personal soil plot (inclusive rect) */
  plot: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Six homesteads spread to the quadrants + the center commons. Doors sit one
 * tile off the y=16 road. Persona placement matches flavor (Sage by the tavern,
 * Moss by the pond, the rest in the corners).
 */
export const HOMESTEADS: HomesteadSpec[] = [
  { id: "dora",  house: { x: 5,  y: 12 }, bed: { x: 6,  y: 14 }, door: { x: 6,  y: 15 }, plot: { x0: 8,  y0: 12, x1: 11, y1: 14 } },
  { id: "gus",   house: { x: 39, y: 12 }, bed: { x: 40, y: 14 }, door: { x: 40, y: 15 }, plot: { x0: 32, y0: 12, x1: 35, y1: 14 } },
  { id: "fern",  house: { x: 5,  y: 18 }, bed: { x: 6,  y: 18 }, door: { x: 6,  y: 17 }, plot: { x0: 8,  y0: 18, x1: 11, y1: 20 } },
  { id: "rusty", house: { x: 39, y: 18 }, bed: { x: 40, y: 18 }, door: { x: 40, y: 17 }, plot: { x0: 32, y0: 18, x1: 35, y1: 20 } },
  { id: "sage",  house: { x: 26, y: 12 }, bed: { x: 27, y: 14 }, door: { x: 27, y: 15 }, plot: { x0: 26, y0: 8,  x1: 29, y1: 10 } },
  { id: "moss",  house: { x: 28, y: 18 }, bed: { x: 29, y: 18 }, door: { x: 29, y: 17 }, plot: { x0: 31, y0: 22, x1: 34, y1: 24 } },
];

/** persona id -> start (door) tile, consumed by src/agents/personas.ts. */
export const HOMESTEAD_DOORS: Record<string, Vec2> = Object.fromEntries(
  HOMESTEADS.map((h) => [h.id, { ...h.door }]),
);

// -- commons (center) --------------------------------------------------------
const SHOP_BUILDING: Vec2 = { x: 16, y: 12 };
const SHOP_TILE: Vec2 = { x: 17, y: 14 }; // bottom-center of the shop building
const SHOP_DOOR: Vec2 = { x: 17, y: 15 };
const TAVERN_BUILDING: Vec2 = { x: 21, y: 12 };
const TAVERN_DOOR: Vec2 = { x: 22, y: 15 };
const POND = { x0: 30, y0: 8, x1: 33, y1: 11 };

// -- back-compat representative exports (existing importers depend on these) --
export const SHOP_POS: Vec2 = { ...SHOP_TILE };
export const BED_POS: Vec2 = { ...HOMESTEADS[0].bed }; // Dora's bed
export const HOUSE_POS: Vec2 = { ...HOMESTEADS[0].door }; // Dora's door
export const WATER_POS: Vec2 = { x: POND.x0, y: POND.y0 }; // a pond edge
export const FIELD_RECT = { ...HOMESTEADS[0].plot }; // Dora's plot

function stampHomestead(tiles: TileType[][], landmarks: Landmark[], h: HomesteadSpec): void {
  fillRect(tiles, h.house.x, h.house.y, h.house.x + 2, h.house.y + 2, "building");
  tiles[h.bed.y][h.bed.x] = "bedTile";
  tiles[h.door.y][h.door.x] = "path";
  fillRect(tiles, h.plot.x0, h.plot.y0, h.plot.x1, h.plot.y1, "soil");
  landmarks.push({ kind: "bed", pos: { ...h.bed } });
  landmarks.push({ kind: "house", pos: { ...h.door } });
}

export function generateMap(): MapData {
  const tiles: TileType[][] = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    tiles.push(new Array<TileType>(MAP_WIDTH).fill("grass"));
  }

  // Wall border.
  fillRect(tiles, 0, 0, MAP_WIDTH - 1, 0, "wall");
  fillRect(tiles, 0, MAP_HEIGHT - 1, MAP_WIDTH - 1, MAP_HEIGHT - 1, "wall");
  fillRect(tiles, 0, 0, 0, MAP_HEIGHT - 1, "wall");
  fillRect(tiles, MAP_WIDTH - 1, 0, MAP_WIDTH - 1, MAP_HEIGHT - 1, "wall");

  // Road network: the y=16 spine every door opens onto, plus three verticals.
  // Laid before structures — they occupy disjoint tiles by construction.
  fillRect(tiles, 1, 16, MAP_WIDTH - 2, 16, "path");
  for (const rx of [12, 24, 36]) fillRect(tiles, rx, 1, rx, MAP_HEIGHT - 2, "path");

  const landmarks: Landmark[] = [];

  for (const h of HOMESTEADS) stampHomestead(tiles, landmarks, h);

  // Shop (trade).
  fillRect(tiles, SHOP_BUILDING.x, SHOP_BUILDING.y, SHOP_BUILDING.x + 2, SHOP_BUILDING.y + 2, "building");
  tiles[SHOP_TILE.y][SHOP_TILE.x] = "shopTile";
  tiles[SHOP_DOOR.y][SHOP_DOOR.x] = "path";
  landmarks.push({ kind: "shop", pos: { ...SHOP_TILE } });

  // Tavern (social hub — a building footprint with a door; no special tile).
  fillRect(tiles, TAVERN_BUILDING.x, TAVERN_BUILDING.y, TAVERN_BUILDING.x + 2, TAVERN_BUILDING.y + 2, "building");
  tiles[TAVERN_DOOR.y][TAVERN_DOOR.x] = "path";
  landmarks.push({ kind: "tavern", pos: { ...TAVERN_DOOR } });

  // Pond (scenery; Moss's spot).
  fillRect(tiles, POND.x0, POND.y0, POND.x1, POND.y1, "water");
  landmarks.push({ kind: "water", pos: { ...WATER_POS } });

  // Decorative trees on open grass (all-grass 4-neighbourhood), deterministic
  // (no RNG) and capped so the bigger map reads alive without clutter.
  const decor: DecorItem[] = [];
  for (let y = 2; y < MAP_HEIGHT - 2 && decor.length < 16; y++) {
    for (let x = 2; x < MAP_WIDTH - 2; x++) {
      if (tiles[y][x] !== "grass") continue;
      const allGrass =
        tiles[y - 1][x] === "grass" &&
        tiles[y + 1][x] === "grass" &&
        tiles[y][x - 1] === "grass" &&
        tiles[y][x + 1] === "grass";
      if (allGrass && (x * 7 + y * 13) % 17 === 0) decor.push({ kind: "tree", pos: { x, y } });
    }
  }

  return { width: MAP_WIDTH, height: MAP_HEIGHT, tiles, landmarks, decor };
}
