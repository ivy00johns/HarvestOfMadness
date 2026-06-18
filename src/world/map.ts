/**
 * Code-generated 64x40 town (no Tiled). Twelve homesteads — each a WALKABLE 5x5
 * room (a `wall` ring with a single `floor` door-gap, a `floor` interior, and
 * one `bedTile`) plus an adjacent soil plot — ring a central commons (walkable
 * tavern, shop, well/notice board, pond). A horizontal road `path` spine at
 * y=20 spans the interior; three vertical roads (x=12/26/40) cross the map.
 *
 * Passability is purely tile-type driven (src/world/Tile.ts → World.isPassable →
 * A*), so door-only entry + interior routing come for free: a `wall` ring is
 * impassable, the one `floor` door-gap is the only way in, and the `floor`
 * interior is fully walkable. No "portal" concept, no pathfinding change.
 *
 * Each homestead door-gap's exterior neighbour is a road tile (roads are stamped
 * FIRST, rooms second), so every interior is BFS-connected to the tavern. The
 * tavern door sits near map centre so every homestead reaches it within one
 * phase (≤ 40 tiles A*; see tests/agents/party-emergence.test.ts).
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

/**
 * Stamp a walkable room into `tiles`: the inclusive [x0,y0]..[x1,y1] rect gets a
 * `wall` ring, a `floor` interior, then the single `door` cell (a perimeter
 * tile) is overwritten to `floor` so it is the room's one passable opening.
 * The room interior is at least 1 wide on each side (callers pass ≥3×3 rects).
 */
function stampRoom(
  tiles: TileType[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  door: Vec2,
): void {
  fillRect(tiles, x0, y0, x1, y1, "wall");
  fillRect(tiles, x0 + 1, y0 + 1, x1 - 1, y1 - 1, "floor");
  tiles[door.y][door.x] = "floor";
}

type DoorSide = "N" | "S" | "E" | "W";

interface HomesteadSpec {
  /** persona id (matches src/agents/personas.ts) */
  id: string;
  /** top-left tile of the 5x5 house room */
  house: Vec2;
  /** bedTile (an interior floor cell of the house) */
  bed: Vec2;
  /** perimeter door-gap (a `floor` tile); the persona's start tile */
  door: Vec2;
  /** which perimeter edge the door sits on (its exterior neighbour is a road) */
  doorSide: DoorSide;
  /** personal soil plot (inclusive rect), nearest cell ≤ Chebyshev 4 of the door */
  plot: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Twelve homesteads in two bands flanking the three vertical roads. Each house
 * is a 5×5 room; the door-gap sits on the edge facing its road (door's exterior
 * neighbour is that road), and the soil plot hugs the open perpendicular side,
 * within OBSERVATION_RADIUS=4 of the door. Persona→quadrant intent (personas.ts)
 * is preserved: brix/ford/wren/dora/gus/clem north; fern/nell/sage/rusty/moss/
 * zola south, west→east.
 */
export const HOMESTEADS: HomesteadSpec[] = [
  // -- north band (houses y=6..10, doors at y=8, plots south y=12..14) --------
  { id: "brix", house: { x: 7,  y: 6 }, bed: { x: 9,  y: 8 }, door: { x: 11, y: 8 }, doorSide: "E", plot: { x0: 8,  y0: 12, x1: 11, y1: 14 } },
  { id: "ford", house: { x: 13, y: 6 }, bed: { x: 15, y: 8 }, door: { x: 13, y: 8 }, doorSide: "W", plot: { x0: 13, y0: 12, x1: 16, y1: 14 } },
  { id: "wren", house: { x: 21, y: 6 }, bed: { x: 23, y: 8 }, door: { x: 25, y: 8 }, doorSide: "E", plot: { x0: 22, y0: 12, x1: 25, y1: 14 } },
  { id: "dora", house: { x: 27, y: 6 }, bed: { x: 29, y: 8 }, door: { x: 27, y: 8 }, doorSide: "W", plot: { x0: 27, y0: 12, x1: 30, y1: 14 } },
  { id: "gus",  house: { x: 35, y: 6 }, bed: { x: 37, y: 8 }, door: { x: 39, y: 8 }, doorSide: "E", plot: { x0: 36, y0: 12, x1: 39, y1: 14 } },
  { id: "clem", house: { x: 41, y: 6 }, bed: { x: 43, y: 8 }, door: { x: 41, y: 8 }, doorSide: "W", plot: { x0: 41, y0: 12, x1: 44, y1: 14 } },
  // -- south band (houses y=29..33, doors at y=31, plots north y=25..27) ------
  { id: "fern",  house: { x: 7,  y: 29 }, bed: { x: 9,  y: 31 }, door: { x: 11, y: 31 }, doorSide: "E", plot: { x0: 8,  y0: 25, x1: 11, y1: 27 } },
  { id: "nell",  house: { x: 13, y: 29 }, bed: { x: 15, y: 31 }, door: { x: 13, y: 31 }, doorSide: "W", plot: { x0: 13, y0: 25, x1: 16, y1: 27 } },
  { id: "sage",  house: { x: 21, y: 29 }, bed: { x: 23, y: 31 }, door: { x: 25, y: 31 }, doorSide: "E", plot: { x0: 22, y0: 25, x1: 25, y1: 27 } },
  { id: "rusty", house: { x: 27, y: 29 }, bed: { x: 29, y: 31 }, door: { x: 27, y: 31 }, doorSide: "W", plot: { x0: 27, y0: 25, x1: 30, y1: 27 } },
  { id: "moss",  house: { x: 35, y: 29 }, bed: { x: 37, y: 31 }, door: { x: 39, y: 31 }, doorSide: "E", plot: { x0: 36, y0: 25, x1: 39, y1: 27 } },
  { id: "zola",  house: { x: 41, y: 29 }, bed: { x: 43, y: 31 }, door: { x: 41, y: 31 }, doorSide: "W", plot: { x0: 41, y0: 25, x1: 44, y1: 27 } },
];

/** persona id -> start (door) tile, consumed by src/agents/personas.ts. */
export const HOMESTEAD_DOORS: Record<string, Vec2> = Object.fromEntries(
  HOMESTEADS.map((h) => [h.id, { ...h.door }]),
);

// -- road network ------------------------------------------------------------
/** horizontal spine `path` row every commons door + the verticals open onto */
const SPINE_Y = 20;
/** three vertical `path` columns crossing the map top-to-bottom */
const VERTICAL_ROADS = [12, 26, 40] as const;

// -- commons (centre) --------------------------------------------------------
// Tavern: walkable 7×5 room, door-gap on the bottom edge dropping onto the
// spine; landmark pos = the door-gap. 5×3 = 15 interior floor tiles ≥ 6 agents.
const TAVERN_ROOM = { x0: 30, y0: 15, x1: 36, y1: 19 };
const TAVERN_DOOR: Vec2 = { x: 33, y: 19 }; // exterior neighbour (33,20) = spine
// Shop: walkable 5×5 room; shopTile on the centre interior cell.
const SHOP_ROOM = { x0: 18, y0: 15, x1: 22, y1: 19 };
const SHOP_DOOR: Vec2 = { x: 20, y: 19 }; // exterior neighbour (20,20) = spine
const SHOP_TILE: Vec2 = { x: 20, y: 17 }; // centre interior cell
// Pond: 4×4 water in the open lower-mid/right area, clear of houses/roads.
const POND = { x0: 47, y0: 21, x1: 50, y1: 24 };

// -- v3: world object positions (exterior, commons + pond area) ---------------
// Well: on open grass just south of the spine, between the x=12 and x=26 roads.
export const WELL_POS: Vec2 = { x: 24, y: 22 };
// Notice board: one step east of the well (same row) — objects.test geometry
// pins board = well + (1,0).
export const NOTICE_BOARD_POS: Vec2 = { x: 25, y: 22 };
// Bench: on grass immediately west of the pond (adjacent to water).
export const BENCH_POS: Vec2 = { x: 46, y: 22 };

/** The three usable world objects placed in the town. */
export const WORLD_OBJECTS: WorldObject[] = [
  { id: "well",         kind: "well",         pos: { ...WELL_POS } },
  { id: "notice_board", kind: "notice_board", pos: { ...NOTICE_BOARD_POS } },
  { id: "bench",        kind: "bench",        pos: { ...BENCH_POS } },
];

// -- back-compat representative exports (existing importers depend on these) --
export const SHOP_POS: Vec2 = { ...SHOP_TILE };
export const BED_POS: Vec2 = { ...HOMESTEADS[0].bed }; // Brix's bed
// Dora's homestead is HOMESTEADS[3]; HOMESTEADS[0] is the north-west room. The
// "house" landmark position IS the walkable door-gap (`floor`), not a wall
// corner — agents start there and tests stand on it.
export const HOUSE_POS: Vec2 = { ...HOMESTEADS[0].door };
// A pond corner — intentionally a "water" tile (the "water" landmark is a water
// tile by contract; see tests/world/world.test.ts), so it is not walkable.
export const WATER_POS: Vec2 = { x: POND.x0, y: POND.y0 };
export const FIELD_RECT = { ...HOMESTEADS[0].plot }; // first homestead's plot

/**
 * Building footprints (twelve homestead rooms + shop + tavern) for the
 * renderer's facade/interior dressing. `doorX` is the entrance column (always
 * within [x0,x1]). The map's renderer reads this so it can never drift from the
 * generated map (see tests/world/map.test.ts).
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
      x1: h.house.x + 4,
      y1: h.house.y + 4,
      doorX: h.door.x,
      kind: "house",
    }),
  ),
  {
    x0: SHOP_ROOM.x0,
    y0: SHOP_ROOM.y0,
    x1: SHOP_ROOM.x1,
    y1: SHOP_ROOM.y1,
    doorX: SHOP_DOOR.x,
    kind: "shop",
  },
  {
    x0: TAVERN_ROOM.x0,
    y0: TAVERN_ROOM.y0,
    x1: TAVERN_ROOM.x1,
    y1: TAVERN_ROOM.y1,
    doorX: TAVERN_DOOR.x,
    kind: "tavern",
  },
];

function stampHomestead(tiles: TileType[][], landmarks: Landmark[], h: HomesteadSpec): void {
  stampRoom(tiles, h.house.x, h.house.y, h.house.x + 4, h.house.y + 4, h.door);
  tiles[h.bed.y][h.bed.x] = "bedTile";
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

  // Road network: the y=20 spine every commons door opens onto, plus three
  // verticals. Stamped BEFORE structures — every door-gap's exterior neighbour
  // is a road tile, so the whole town is connected with no path stubs.
  fillRect(tiles, 1, SPINE_Y, MAP_WIDTH - 2, SPINE_Y, "path");
  for (const rx of VERTICAL_ROADS) fillRect(tiles, rx, 1, rx, MAP_HEIGHT - 2, "path");

  const landmarks: Landmark[] = [];

  for (const h of HOMESTEADS) stampHomestead(tiles, landmarks, h);

  // Shop (trade) — walkable room with the shopTile on its centre interior cell.
  stampRoom(tiles, SHOP_ROOM.x0, SHOP_ROOM.y0, SHOP_ROOM.x1, SHOP_ROOM.y1, SHOP_DOOR);
  tiles[SHOP_TILE.y][SHOP_TILE.x] = "shopTile";
  landmarks.push({ kind: "shop", pos: { ...SHOP_TILE } });

  // Tavern (social hub) — walkable room; landmark pos = the door-gap floor tile.
  stampRoom(tiles, TAVERN_ROOM.x0, TAVERN_ROOM.y0, TAVERN_ROOM.x1, TAVERN_ROOM.y1, TAVERN_DOOR);
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
