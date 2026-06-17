/**
 * Code-generated 48x32 town (no Tiled). Twelve homesteads — each a 3x3 house
 * with its own bed and an adjacent soil plot — ring a central commons (shop,
 * tavern, pond). A horizontal road at y=16 spans the interior; the original six
 * doors open onto it (y=15 or y=17). Three vertical roads (x=12/24/36) add
 * cross-town travel; the six new homesteads place their doors directly ON these
 * vertical roads (also path tiles), so the whole town is connected with no path
 * stubs.
 *
 * Divergence is spatial: each agent starts at its own door and the LLM/mock both
 * act on the NEAREST crop/tile/bed, so agents tend their own plots and sleep in
 * their own beds without any ownership rules.
 */
import type { Landmark, TileType, Vec2, WorldObject } from "@contracts/types";
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
  /** v3 — interactable world objects (well, notice_board, bench) */
  objects: WorldObject[];
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
 * Twelve homesteads spread across the map. The original six doors sit one tile
 * off the y=16 horizontal road (y=15 or y=17). The six new homesteads place
 * their doors directly on a vertical road (x=12, x=24, or x=36), which are all
 * path tiles, so every door is passable and BFS-connected to the tavern.
 */
export const HOMESTEADS: HomesteadSpec[] = [
  // -- original six (unchanged) -----------------------------------------------
  { id: "dora",  house: { x: 5,  y: 12 }, bed: { x: 6,  y: 14 }, door: { x: 6,  y: 15 }, plot: { x0: 8,  y0: 12, x1: 11, y1: 14 } },
  { id: "gus",   house: { x: 39, y: 12 }, bed: { x: 40, y: 14 }, door: { x: 40, y: 15 }, plot: { x0: 42, y0: 12, x1: 45, y1: 14 } },
  { id: "fern",  house: { x: 5,  y: 18 }, bed: { x: 6,  y: 18 }, door: { x: 6,  y: 17 }, plot: { x0: 8,  y0: 18, x1: 11, y1: 20 } },
  { id: "rusty", house: { x: 39, y: 18 }, bed: { x: 40, y: 18 }, door: { x: 40, y: 17 }, plot: { x0: 42, y0: 18, x1: 45, y1: 20 } },
  { id: "sage",  house: { x: 26, y: 12 }, bed: { x: 27, y: 14 }, door: { x: 27, y: 15 }, plot: { x0: 29, y0: 12, x1: 32, y1: 14 } },
  { id: "moss",  house: { x: 28, y: 18 }, bed: { x: 29, y: 18 }, door: { x: 29, y: 17 }, plot: { x0: 31, y0: 18, x1: 34, y1: 20 } },
  // -- six new homesteads (doors on vertical roads x=12/24/36) -----------------
  // Each bed is on the road-facing edge of its house so door→bed is one step.
  // brix: NW upper quadrant, house west of x=12 road, door ON road
  { id: "brix",  house: { x: 9,  y: 3  }, bed: { x: 11, y: 4  }, door: { x: 12, y: 4  }, plot: { x0: 6,  y0: 3,  x1: 8,  y1: 5  } },
  // nell: SW lower quadrant, house west of x=12 road, door ON road
  { id: "nell",  house: { x: 9,  y: 23 }, bed: { x: 11, y: 24 }, door: { x: 12, y: 24 }, plot: { x0: 6,  y0: 23, x1: 8,  y1: 25 } },
  // wren: N central, house west of x=24 road, door ON road
  { id: "wren",  house: { x: 20, y: 3  }, bed: { x: 22, y: 4  }, door: { x: 24, y: 4  }, plot: { x0: 25, y0: 3,  x1: 27, y1: 5  } },
  // clem: S central, house west of x=24 road, door ON road
  { id: "clem",  house: { x: 20, y: 23 }, bed: { x: 22, y: 24 }, door: { x: 24, y: 24 }, plot: { x0: 25, y0: 23, x1: 27, y1: 25 } },
  // ford: NE upper quadrant, house east of x=36 road, door ON road
  { id: "ford",  house: { x: 37, y: 3  }, bed: { x: 37, y: 4  }, door: { x: 36, y: 4  }, plot: { x0: 40, y0: 3,  x1: 43, y1: 5  } },
  // zola: SE lower quadrant, house east of x=36 road, door ON road
  { id: "zola",  house: { x: 37, y: 23 }, bed: { x: 37, y: 24 }, door: { x: 36, y: 24 }, plot: { x0: 40, y0: 23, x1: 43, y1: 25 } },
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

// -- v3: world object positions (exterior, commons + pond area) ---------------
// Well: on the main road between shop and tavern doors (in the commons)
export const WELL_POS: Vec2 = { x: 19, y: 16 };
// Notice board: one step east of the well, also in the commons
export const NOTICE_BOARD_POS: Vec2 = { x: 20, y: 16 };
// Bench: one tile to the left of the pond (grass tile adjacent to water)
export const BENCH_POS: Vec2 = { x: 29, y: 10 };

/** The three usable world objects placed in the town. */
export const WORLD_OBJECTS: WorldObject[] = [
  { id: "well",         kind: "well",         pos: { ...WELL_POS } },
  { id: "notice_board", kind: "notice_board", pos: { ...NOTICE_BOARD_POS } },
  { id: "bench",        kind: "bench",        pos: { ...BENCH_POS } },
];

// -- back-compat representative exports (existing importers depend on these) --
export const SHOP_POS: Vec2 = { ...SHOP_TILE };
export const BED_POS: Vec2 = { ...HOMESTEADS[0].bed }; // Dora's bed
// Dora's door — this IS the "house" landmark position (a walkable path tile in
// front of the house), not the building corner.
export const HOUSE_POS: Vec2 = { ...HOMESTEADS[0].door };
// A pond corner — intentionally a "water" tile (the "water" landmark is a water
// tile by contract; see tests/world/world.test.ts), so it is not walkable.
export const WATER_POS: Vec2 = { x: POND.x0, y: POND.y0 };
export const FIELD_RECT = { ...HOMESTEADS[0].plot }; // Dora's plot

/**
 * Building footprints (twelve homestead houses + shop + tavern) for the
 * renderer's facade dressing. `doorX` is the entrance column (always within
 * [x0,x1]). The map's facade renderer reads this so it can never drift from
 * the generated map (see tests/world/map.test.ts).
 */
export interface BuildingFootprint {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  doorX: number;
  kind: "house" | "shop" | "tavern";
}

export const BUILDINGS: BuildingFootprint[] = [
  ...HOMESTEADS.map(
    (h): BuildingFootprint => ({
      x0: h.house.x,
      y0: h.house.y,
      x1: h.house.x + 2,
      y1: h.house.y + 2,
      doorX: h.bed.x,
      kind: "house",
    }),
  ),
  {
    x0: SHOP_BUILDING.x,
    y0: SHOP_BUILDING.y,
    x1: SHOP_BUILDING.x + 2,
    y1: SHOP_BUILDING.y + 2,
    doorX: SHOP_TILE.x,
    kind: "shop",
  },
  {
    x0: TAVERN_BUILDING.x,
    y0: TAVERN_BUILDING.y,
    x1: TAVERN_BUILDING.x + 2,
    y1: TAVERN_BUILDING.y + 2,
    doorX: TAVERN_DOOR.x,
    kind: "tavern",
  },
];

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
  // (no RNG) and capped so the bigger map reads alive without clutter. The
  // (x*7 + y*13) % 17 test is a cheap coprime scatter selecting ~1/17 of
  // eligible tiles with no clustering.
  const decor: DecorItem[] = [];
  for (let y = 2; y < MAP_HEIGHT - 2 && decor.length < 16; y++) {
    for (let x = 2; x < MAP_WIDTH - 2; x++) {
      if (tiles[y][x] !== "grass") continue;
      const allGrass =
        tiles[y - 1][x] === "grass" &&
        tiles[y + 1][x] === "grass" &&
        tiles[y][x - 1] === "grass" &&
        tiles[y][x + 1] === "grass";
      // Hard cap at 16: guard the push itself — the outer-loop guard alone lets
      // a single row overshoot, since it is only re-checked between rows.
      if (decor.length < 16 && allGrass && (x * 7 + y * 13) % 17 === 0) {
        decor.push({ kind: "tree", pos: { x, y } });
      }
    }
  }

  return { width: MAP_WIDTH, height: MAP_HEIGHT, tiles, landmarks, decor, objects: WORLD_OBJECTS.map((o) => ({ ...o, pos: { ...o.pos } })) };
}
