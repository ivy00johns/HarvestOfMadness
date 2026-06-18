/**
 * Code-generated 64x40 town (no Tiled). An ORGANIC, asymmetric Smallville-style
 * town: varied-size walkable homestead rooms, a downtown civic cluster (shop +
 * tavern + cafe + office + school) around a central plaza, a green PARK with an
 * inner pond, and a road network laid down BEFORE the rooms so every door opens
 * straight onto a path.
 *
 * Generation is fully DETERMINISTIC — hand-authored spec tables (HOMESTEADS,
 * COMMONS, ROAD_SEGMENTS, PARK) plus a coprime decor scatter; zero RNG, zero
 * Date.now. Re-running generateMap() always yields the identical map.
 *
 * Passability is purely tile-type driven (src/world/Tile.ts → World.isPassable →
 * A*), so door-only entry + interior routing come for free: a `wall` ring is
 * impassable, the one `floor` door-gap is the only way in, and the `floor`
 * interior is fully walkable. No "portal" concept, no pathfinding change.
 *
 * Each room's door-gap exterior neighbour is a road tile (roads are stamped
 * FIRST, rooms second), so every interior is BFS-connected to the tavern. The
 * tavern sits centrally in the downtown cluster so every homestead reaches it
 * within one phase (≤ 40 tiles A*; see tests/agents/party-emergence.test.ts).
 *
 * A horizontal main-connector path row at y=20 spans the interior (the spine
 * the downtown doors + the vertical roads open onto). Divergence is spatial:
 * each agent starts at its own door and the LLM/mock both act on the NEAREST
 * crop/tile/bed, so agents tend their own plots and sleep in their own beds
 * without any ownership rules.
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
 * Size-agnostic — works for 4×4, 5×5, 6×5, 7×5 rooms alike.
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

/** The exterior tile one step outside a door on its perimeter edge. */
function exteriorOf(door: Vec2, side: DoorSide): Vec2 {
  switch (side) {
    case "N":
      return { x: door.x, y: door.y - 1 };
    case "S":
      return { x: door.x, y: door.y + 1 };
    case "E":
      return { x: door.x + 1, y: door.y };
    case "W":
      return { x: door.x - 1, y: door.y };
  }
}

interface HomesteadSpec {
  /** persona id (matches src/agents/personas.ts) */
  id: string;
  /** top-left tile of the house room (size from x1/y1 below) */
  house: Vec2;
  /** bottom-right tile of the house room (varied: 4×4 / 5×5 / 6×5) */
  size: { w: number; h: number };
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
 * Twelve homesteads scattered in an organic, asymmetric arrangement around the
 * downtown civic core. Sizes VARY (4×4, 5×5, 6×5) so the town reads
 * hand-built; each door faces a residential road spur (its exterior neighbour is
 * a `path`), and the soil plot hugs an open side within OBSERVATION_RADIUS=4 of
 * the door. Persona→quadrant intent (personas.ts) is preserved loosely: brix/
 * ford/wren/dora/gus/clem north; fern/nell/sage/rusty/moss/zola south.
 *
 * IDs and the one-bed-per-house invariant are unchanged, so personas.ts and the
 * 12-bed / 12-house landmark contract hold. Variety comes from SIZE + organic
 * placement, never from changing the count.
 */
export const HOMESTEADS: HomesteadSpec[] = [
  // -- north band (rooms above the spine; doors face SOUTH onto the y=12
  //    residential row → exterior neighbour = door.y + 1 = 12 = path). Soil
  //    plots hug an OPEN side beside the house, nearest cell ≤ Chebyshev 4 of
  //    the door. Sizes vary (5×5 / 6×5 / 4×4) for an organic, hand-built feel. --
  // 5×5 — plot to the EAST
  { id: "brix", house: { x: 2,  y: 7 }, size: { w: 5, h: 5 }, bed: { x: 4,  y: 9 }, door: { x: 4,  y: 11 }, doorSide: "S", plot: { x0: 7,  y0: 9, x1: 9,  y1: 11 } },
  // 6×5 (wide) — plot to the WEST
  { id: "ford", house: { x: 14, y: 7 }, size: { w: 6, h: 5 }, bed: { x: 16, y: 9 }, door: { x: 16, y: 11 }, doorSide: "S", plot: { x0: 11, y0: 9, x1: 13, y1: 11 } },
  // 4×4 (small) — plot to the EAST
  { id: "wren", house: { x: 22, y: 8 }, size: { w: 4, h: 4 }, bed: { x: 23, y: 9 }, door: { x: 23, y: 11 }, doorSide: "S", plot: { x0: 26, y0: 9, x1: 28, y1: 11 } },
  // 5×5 — plot to the WEST
  { id: "dora", house: { x: 38, y: 7 }, size: { w: 5, h: 5 }, bed: { x: 40, y: 9 }, door: { x: 40, y: 11 }, doorSide: "S", plot: { x0: 34, y0: 9, x1: 36, y1: 11 } },
  // 6×5 (wide) — plot to the EAST
  { id: "gus",  house: { x: 45, y: 7 }, size: { w: 6, h: 5 }, bed: { x: 47, y: 9 }, door: { x: 47, y: 11 }, doorSide: "S", plot: { x0: 51, y0: 9, x1: 53, y1: 11 } },
  // 4×4 (small) — plot to the WEST
  { id: "clem", house: { x: 57, y: 8 }, size: { w: 4, h: 4 }, bed: { x: 58, y: 9 }, door: { x: 58, y: 11 }, doorSide: "S", plot: { x0: 54, y0: 9, x1: 56, y1: 11 } },
  // -- south band (rooms below the spine; doors face NORTH onto the y=28
  //    residential row → exterior neighbour = door.y - 1 = 28 = path). --------
  // 5×5 — plot to the EAST
  { id: "fern",  house: { x: 2,  y: 29 }, size: { w: 5, h: 5 }, bed: { x: 4,  y: 31 }, door: { x: 4,  y: 29 }, doorSide: "N", plot: { x0: 7,  y0: 29, x1: 9,  y1: 31 } },
  // 4×4 (small) — plot to the EAST
  { id: "nell",  house: { x: 14, y: 29 }, size: { w: 4, h: 4 }, bed: { x: 15, y: 30 }, door: { x: 15, y: 29 }, doorSide: "N", plot: { x0: 18, y0: 29, x1: 20, y1: 31 } },
  // 6×5 (wide) — plot to the WEST
  { id: "sage",  house: { x: 24, y: 29 }, size: { w: 6, h: 5 }, bed: { x: 26, y: 31 }, door: { x: 26, y: 29 }, doorSide: "N", plot: { x0: 21, y0: 29, x1: 23, y1: 31 } },
  // 5×5 — plot to the WEST
  { id: "rusty", house: { x: 38, y: 29 }, size: { w: 5, h: 5 }, bed: { x: 40, y: 31 }, door: { x: 40, y: 29 }, doorSide: "N", plot: { x0: 34, y0: 29, x1: 36, y1: 31 } },
  // 4×4 (small) — plot to the EAST
  { id: "moss",  house: { x: 45, y: 29 }, size: { w: 4, h: 4 }, bed: { x: 46, y: 30 }, door: { x: 46, y: 29 }, doorSide: "N", plot: { x0: 49, y0: 29, x1: 51, y1: 31 } },
  // 6×5 (wide) — plot to the WEST
  { id: "zola",  house: { x: 55, y: 29 }, size: { w: 6, h: 5 }, bed: { x: 57, y: 31 }, door: { x: 57, y: 29 }, doorSide: "N", plot: { x0: 52, y0: 29, x1: 54, y1: 31 } },
];

/** persona id -> start (door) tile, consumed by src/agents/personas.ts. */
export const HOMESTEAD_DOORS: Record<string, Vec2> = Object.fromEntries(
  HOMESTEADS.map((h) => [h.id, { ...h.door }]),
);

// -- road network ------------------------------------------------------------
// A hand-authored set of road SEGMENTS (each a 1-wide horizontal or vertical
// run, inclusive endpoints) forming a downtown loop around the plaza, the main
// y=20 connector spine, residential spurs each homestead door drops onto, and
// park access. Stamped BEFORE rooms so every door's exterior neighbour is path.

/** main connector path row — the spine the verticals + downtown doors meet. */
const SPINE_Y = 20;

interface RoadSeg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * ROAD_SEGMENTS — every road run in the town. Order is irrelevant (they are all
 * stamped to `path`). Authored so: (a) the y=20 spine spans the interior; (b) a
 * downtown loop rings the central plaza; (c) residential spurs sit just outside
 * each homestead door; (d) verticals tie the bands to the spine.
 */
export const ROAD_SEGMENTS: RoadSeg[] = [
  // main horizontal connector spine (y=20) across the interior.
  { x0: 1, y0: SPINE_Y, x1: MAP_WIDTH - 2, y1: SPINE_Y },
  // -- north residential row (y=12) the north doors' exteriors (y=12) sit on --
  { x0: 4,  y0: 12, x1: 60, y1: 12 },
  // -- south residential row (y=28) the south doors' exteriors (y=28) sit on --
  { x0: 4,  y0: 28, x1: 60, y1: 28 },
  // -- vertical trunks tying the residential rows down to the spine ----------
  { x0: 4,  y0: 12, x1: 4,  y1: 28 }, // far-west trunk (brix / fern)
  { x0: 16, y0: 12, x1: 16, y1: 28 }, // west-mid trunk
  { x0: 26, y0: 12, x1: 26, y1: 28 }, // mid-left trunk
  { x0: 40, y0: 12, x1: 40, y1: 28 }, // mid-right trunk
  { x0: 50, y0: 12, x1: 50, y1: 28 }, // east-mid trunk
  { x0: 60, y0: 12, x1: 60, y1: 28 }, // far-east trunk (clem / zola)
  // -- downtown plaza: a compact loop just above the spine, x 18..44, y 19 ----
  // The civic doors all drop onto the y=19 plaza row (one above the spine),
  // which is itself joined to the spine by short verticals at each door column.
  { x0: 18, y0: 19, x1: 44, y1: 19 }, // plaza row (civic door exteriors)
  { x0: 20, y0: 19, x1: 20, y1: 20 }, // shop column joiner to spine
  { x0: 31, y0: 19, x1: 31, y1: 20 }, // tavern column joiner to spine
  { x0: 41, y0: 19, x1: 41, y1: 20 }, // cafe column joiner to spine
  // The PARK (open grass, y=14..19) needs no road: its bottom row (y=19) sits
  // directly on top of the spine (y=20), so the whole region is BFS-connected.
];

// -- downtown civic cluster --------------------------------------------------
// Each COMMONS room is walkable (wall ring + single floor door-gap). The door's
// exterior neighbour is a downtown-loop path tile. shop carries a shopTile;
// tavern's landmark = the door-gap. cafe/office are net-new room kinds (5a is
// environmental only); school is a room with NO landmark (counts stay crisp).
type CommonsKind = "shop" | "tavern" | "cafe" | "office" | "school";

interface CommonsSpec {
  kind: CommonsKind;
  rect: { x0: number; y0: number; x1: number; y1: number };
  door: Vec2;
  doorSide: DoorSide;
  /** shop only — the BUY/SELL gate cell (a `shopTile`) on an interior floor */
  specialTile?: Vec2;
}

/**
 * COMMONS — the five civic rooms ringing the plaza. Doors all open onto the
 * downtown loop / spine. The tavern is dead-centre so every homestead door is
 * ≤ 40 A* tiles away (party-emergence reachability gate).
 */
const COMMONS: CommonsSpec[] = [
  // Tavern: walkable 7×5 room, dead-centre just above the spine; door drops
  // south onto the plaza row (y=19), one tile above the spine. landmark pos =
  // the door-gap, so it is ≤ 2 tiles from the spine for every approaching agent.
  { kind: "tavern", rect: { x0: 28, y0: 14, x1: 34, y1: 18 }, door: { x: 31, y: 18 }, doorSide: "S" },
  // Shop: walkable 5×5 room, west of the tavern; door south onto the plaza row.
  // shopTile on the centre interior cell.
  { kind: "shop", rect: { x0: 18, y0: 14, x1: 22, y1: 18 }, door: { x: 20, y: 18 }, doorSide: "S", specialTile: { x: 20, y: 16 } },
  // Cafe: walkable 5×4 room, east of the tavern; door south onto the plaza row.
  { kind: "cafe", rect: { x0: 39, y0: 15, x1: 43, y1: 18 }, door: { x: 41, y: 18 }, doorSide: "S" },
  // Office: walkable 5×5 room, below-left of the spine; door north onto the spine.
  { kind: "office", rect: { x0: 22, y0: 21, x1: 26, y1: 25 }, door: { x: 24, y: 21 }, doorSide: "N" },
  // School: walkable 6×5 room, below-right of the spine; door north onto the spine.
  { kind: "school", rect: { x0: 35, y0: 21, x1: 40, y1: 25 }, door: { x: 38, y: 21 }, doorSide: "N" },
];

const SHOP_SPEC = COMMONS.find((c) => c.kind === "shop")!;
const SHOP_TILE: Vec2 = { ...SHOP_SPEC.specialTile! };

// -- park --------------------------------------------------------------------
// An open green region (NOT a walled room): mostly walkable grass with an inner
// pond (water) and a few benches/trees. Sits in the open SE flat, clear of the
// rooms and roads. The pond is ≥4 wide with grass flanks (pathfinding pond
// detour test). WATER_POS is the pond's NW corner.
export const PARK = { x0: 49, y0: 14, x1: 54, y1: 19 };
/** Inner pond: 4 wide, grass border inside the park region. */
const POND = { x0: 50, y0: 15, x1: 53, y1: 17 };

// -- v3: world object positions (plaza + park) -------------------------------
// Well: on the central plaza row, between the shop and the tavern columns.
export const WELL_POS: Vec2 = { x: 25, y: 19 };
// Notice board: one step east of the well (same row) — objects.test geometry
// pins board = well + (1,0).
export const NOTICE_BOARD_POS: Vec2 = { x: 26, y: 19 };
// Bench: on park grass immediately west of the pond (adjacent to water).
export const BENCH_POS: Vec2 = { x: 49, y: 16 };
// A second bench INSIDE the park (typology park-bench test), east of the pond.
const PARK_BENCH_POS: Vec2 = { x: 54, y: 16 };

/** The usable world objects placed in the town (well, board, two benches). */
export const WORLD_OBJECTS: WorldObject[] = [
  { id: "well",         kind: "well",         pos: { ...WELL_POS } },
  { id: "notice_board", kind: "notice_board", pos: { ...NOTICE_BOARD_POS } },
  { id: "bench",        kind: "bench",        pos: { ...BENCH_POS } },
  { id: "park_bench",   kind: "bench",        pos: { ...PARK_BENCH_POS } },
];

// -- back-compat representative exports (existing importers depend on these) --
export const SHOP_POS: Vec2 = { ...SHOP_TILE };
export const BED_POS: Vec2 = { ...HOMESTEADS[0].bed }; // Brix's bed
// The "house" landmark position IS the walkable door-gap (`floor`), not a wall
// corner — agents start there and tests stand on it.
export const HOUSE_POS: Vec2 = { ...HOMESTEADS[0].door };
// A pond corner — intentionally a "water" tile (the "water" landmark is a water
// tile by contract; see tests/world/world.test.ts), so it is not walkable.
export const WATER_POS: Vec2 = { x: POND.x0, y: POND.y0 };
export const FIELD_RECT = { ...HOMESTEADS[0].plot }; // first homestead's plot

/**
 * Building footprints (the 12 homestead rooms + the 5 civic rooms = 17) for the
 * renderer's facade/interior dressing. `doorX` is the entrance column (always
 * within [x0,x1]). The map's renderer reads this so it can never drift from the
 * generated map (see tests/world/map.test.ts).
 */
export type BuildingKind = "house" | "shop" | "tavern" | "cafe" | "office" | "school";

export interface BuildingFootprint {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  doorX: number;
  kind: BuildingKind;
  /** which perimeter edge the door sits on (door exterior neighbour is a road) */
  doorSide: DoorSide;
}

export const BUILDINGS: BuildingFootprint[] = [
  ...HOMESTEADS.map(
    (h): BuildingFootprint => ({
      x0: h.house.x,
      y0: h.house.y,
      x1: h.house.x + h.size.w - 1,
      y1: h.house.y + h.size.h - 1,
      doorX: h.door.x,
      kind: "house",
      doorSide: h.doorSide,
    }),
  ),
  ...COMMONS.map(
    (c): BuildingFootprint => ({
      x0: c.rect.x0,
      y0: c.rect.y0,
      x1: c.rect.x1,
      y1: c.rect.y1,
      doorX: c.door.x,
      kind: c.kind,
      doorSide: c.doorSide,
    }),
  ),
];

function stampHomestead(tiles: TileType[][], landmarks: Landmark[], h: HomesteadSpec): void {
  const x1 = h.house.x + h.size.w - 1;
  const y1 = h.house.y + h.size.h - 1;
  stampRoom(tiles, h.house.x, h.house.y, x1, y1, h.door);
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

  // Road network FIRST — every door-gap's exterior neighbour is a road tile,
  // so the whole town is connected with no path stubs. Authored segments only
  // (deterministic; no RNG).
  for (const s of ROAD_SEGMENTS) fillRect(tiles, s.x0, s.y0, s.x1, s.y1, "path");

  const landmarks: Landmark[] = [];

  // Homesteads (varied sizes) — rooms over roads, soil plots, bed + house
  // landmarks (12 each).
  for (const h of HOMESTEADS) stampHomestead(tiles, landmarks, h);

  // Civic cluster (shop / tavern / cafe / office / school).
  for (const c of COMMONS) {
    stampRoom(tiles, c.rect.x0, c.rect.y0, c.rect.x1, c.rect.y1, c.door);
    if (c.kind === "shop" && c.specialTile) {
      tiles[c.specialTile.y][c.specialTile.x] = "shopTile";
      landmarks.push({ kind: "shop", pos: { ...c.specialTile } });
    } else if (c.kind === "tavern") {
      landmarks.push({ kind: "tavern", pos: { ...c.door } });
    } else if (c.kind === "cafe") {
      landmarks.push({ kind: "cafe", pos: { ...c.door } });
    } else if (c.kind === "office") {
      landmarks.push({ kind: "office", pos: { ...c.door } });
    }
    // school: no landmark (keeps the landmark counts crisp).
  }

  // Park: an open green region with an inner pond. The region itself is grass
  // (already grass from the fill), so it stays walkable; stamp only the pond
  // water. The "park" landmark marks the region centre (a walkable grass tile).
  fillRect(tiles, POND.x0, POND.y0, POND.x1, POND.y1, "water");
  landmarks.push({ kind: "water", pos: { ...WATER_POS } });
  const parkCentre: Vec2 = { x: PARK.x1, y: PARK.y1 }; // SE park corner — grass
  landmarks.push({ kind: "park", pos: { ...parkCentre } });

  // Decorative trees on open grass (all-grass 4-neighbourhood), deterministic
  // (no RNG) and capped so the bigger map reads alive without clutter. The
  // (x*7 + y*13) % 17 test is a cheap coprime scatter selecting ~1/17 of
  // eligible tiles with no clustering. Park-region grass tiles are eligible
  // too, so a few trees naturally bias into the park.
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
  // Guarantee at least one tree INSIDE the park region (typology park test):
  // pick a deterministic park grass cell clear of the pond + benches.
  const parkTree: Vec2 = { x: PARK.x0, y: PARK.y0 + 1 };
  if (
    tiles[parkTree.y][parkTree.x] === "grass" &&
    !decor.some((d) => d.pos.x === parkTree.x && d.pos.y === parkTree.y)
  ) {
    // Replace the last scattered tree if we are at the cap, else append.
    if (decor.length >= 16) decor[decor.length - 1] = { kind: "tree", pos: { ...parkTree } };
    else decor.push({ kind: "tree", pos: { ...parkTree } });
  }

  return { width: MAP_WIDTH, height: MAP_HEIGHT, tiles, landmarks, decor, objects: WORLD_OBJECTS.map((o) => ({ ...o, pos: { ...o.pos } })) };
}

// Internal helpers exported for tests that derive structure (not coordinates).
export { exteriorOf };
export type { DoorSide, HomesteadSpec, CommonsSpec, CommonsKind };
export { COMMONS, SPINE_Y, POND };
