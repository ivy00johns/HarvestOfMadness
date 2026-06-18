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

export type DecorKind = "tree" | "bush" | "flower" | "grass";

export interface DecorItem {
  kind: DecorKind;
  pos: Vec2;
  /** deterministic variant index into the kind's renderer frame list */
  variant: number;
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
  // -- north band: doors face S onto the y=22 road (house bottom row y=21). Soil
  //    plots hug an OPEN side beside the house, nearest cell ≤ Chebyshev 4 of
  //    the door. Sizes vary (5×5 / 6×5 / 4×4) for an organic, hand-built feel. --
  // 5×5 — plot to the WEST; its south edge (y=21) borders the y=22 road so the
  //   executor TILL-rejects-road test (FIELD_RECT = this plot) finds a road neighbour.
  { id: "brix", house: { x: 25, y: 17 }, size: { w: 5, h: 5 }, bed: { x: 27, y: 19 }, door: { x: 27, y: 21 }, doorSide: "S", plot: { x0: 21, y0: 19, x1: 23, y1: 21 } },
  // 6×5 (wide) — plot to the EAST (between ford and wren)
  { id: "ford", house: { x: 31, y: 17 }, size: { w: 6, h: 5 }, bed: { x: 34, y: 19 }, door: { x: 34, y: 21 }, doorSide: "S", plot: { x0: 38, y0: 18, x1: 39, y1: 20 } },
  // 4×4 (small) — plot to the EAST (between wren and dora)
  { id: "wren", house: { x: 41, y: 18 }, size: { w: 4, h: 4 }, bed: { x: 42, y: 19 }, door: { x: 42, y: 21 }, doorSide: "S", plot: { x0: 45, y0: 19, x1: 47, y1: 21 } },
  // 5×5 — plot to the WEST (between wren and dora, lower row)
  { id: "dora", house: { x: 52, y: 17 }, size: { w: 5, h: 5 }, bed: { x: 54, y: 19 }, door: { x: 54, y: 21 }, doorSide: "S", plot: { x0: 49, y0: 18, x1: 50, y1: 20 } },
  // 6×5 (wide) — plot to the EAST (between gus and clem)
  { id: "gus",  house: { x: 58, y: 17 }, size: { w: 6, h: 5 }, bed: { x: 60, y: 19 }, door: { x: 60, y: 21 }, doorSide: "S", plot: { x0: 64, y0: 18, x1: 65, y1: 20 } },
  // 4×4 (small) — plot to the EAST (right of clem)
  { id: "clem", house: { x: 67, y: 18 }, size: { w: 4, h: 4 }, bed: { x: 68, y: 19 }, door: { x: 68, y: 21 }, doorSide: "S", plot: { x0: 71, y0: 19, x1: 73, y1: 21 } },
  // -- south band: doors face N onto the y=50 road; house top row y=51 ---------
  // 5×5 — plot to the WEST
  { id: "fern",  house: { x: 25, y: 51 }, size: { w: 5, h: 5 }, bed: { x: 27, y: 53 }, door: { x: 27, y: 51 }, doorSide: "N", plot: { x0: 21, y0: 52, x1: 23, y1: 54 } },
  // 4×4 (small) — plot to the EAST
  { id: "nell",  house: { x: 33, y: 51 }, size: { w: 4, h: 4 }, bed: { x: 34, y: 53 }, door: { x: 34, y: 51 }, doorSide: "N", plot: { x0: 38, y0: 52, x1: 39, y1: 54 } },
  // 6×5 (wide) — plot to the EAST
  { id: "sage",  house: { x: 41, y: 51 }, size: { w: 6, h: 5 }, bed: { x: 44, y: 53 }, door: { x: 44, y: 51 }, doorSide: "N", plot: { x0: 48, y0: 52, x1: 49, y1: 54 } },
  // 5×5 — plot to the EAST
  { id: "rusty", house: { x: 52, y: 51 }, size: { w: 5, h: 5 }, bed: { x: 54, y: 53 }, door: { x: 54, y: 51 }, doorSide: "N", plot: { x0: 57, y0: 52, x1: 59, y1: 54 } },
  // 4×4 (small) — plot to the EAST
  { id: "moss",  house: { x: 60, y: 51 }, size: { w: 4, h: 4 }, bed: { x: 61, y: 53 }, door: { x: 62, y: 51 }, doorSide: "N", plot: { x0: 64, y0: 52, x1: 65, y1: 54 } },
  // 6×5 (wide) — plot to the EAST
  { id: "zola",  house: { x: 66, y: 51 }, size: { w: 6, h: 5 }, bed: { x: 68, y: 53 }, door: { x: 68, y: 51 }, doorSide: "N", plot: { x0: 72, y0: 52, x1: 73, y1: 54 } },
];

/** persona id -> start (door) tile, consumed by src/agents/personas.ts. */
export const HOMESTEAD_DOORS: Record<string, Vec2> = Object.fromEntries(
  HOMESTEADS.map((h) => [h.id, { ...h.door }]),
);

/**
 * A reserved, road-adjacent grass footprint for a FUTURE homestead. Stamps no
 * tiles, adds no landmark, binds no persona — pure capacity the agents layer
 * can later activate (add a persona + promote to HOMESTEADS) with no re-survey.
 *
 * The lots live on the INNER sides of the two residential roads (the grass band
 * between each road and the central spine), where there is ample open grass: the
 * inner-north lots' doors face N onto the y=22 road, the inner-south lots' doors
 * face S onto the y=50 road. Each footprint sits in a gap between the vertical
 * trunks and clear of the downtown core + park, so every footprint+plot tile is
 * grass and each door's exterior neighbour is already a `path` (drop-in ready).
 */
export interface ReserveLot {
  id: string;
  house: { x0: number; y0: number; x1: number; y1: number };
  bed: Vec2;
  door: Vec2;
  doorSide: DoorSide;
  plot: { x0: number; y0: number; x1: number; y1: number };
}

export const RESERVE_LOTS: ReserveLot[] = [
  // -- inner-north strip: house top row y=23, door faces N onto the y=22 road;
  //    plot sits directly below the house (Chebyshev ≤ 4 of the door). Houses
  //    nestle in the gaps between the vertical trunks (x=8,16,24,…) and stay in
  //    the central band so each lot's door is ≤ 40 A* tiles of the tavern
  //    (drop-in ready, same reachability bound as the occupied homesteads). ----
  { id: "lot_n1", house: { x0: 26, y0: 23, x1: 29, y1: 26 }, bed: { x: 27, y: 24 }, door: { x: 27, y: 23 }, doorSide: "N", plot: { x0: 26, y0: 27, x1: 28, y1: 28 } },
  { id: "lot_n2", house: { x0: 34, y0: 23, x1: 37, y1: 26 }, bed: { x: 35, y: 24 }, door: { x: 35, y: 23 }, doorSide: "N", plot: { x0: 34, y0: 27, x1: 36, y1: 28 } },
  { id: "lot_n3", house: { x0: 41, y0: 23, x1: 44, y1: 26 }, bed: { x: 42, y: 24 }, door: { x: 42, y: 23 }, doorSide: "N", plot: { x0: 41, y0: 27, x1: 43, y1: 28 } },
  { id: "lot_n4", house: { x0: 49, y0: 23, x1: 52, y1: 26 }, bed: { x: 50, y: 24 }, door: { x: 50, y: 23 }, doorSide: "N", plot: { x0: 49, y0: 27, x1: 51, y1: 28 } },
  { id: "lot_n5", house: { x0: 58, y0: 23, x1: 61, y1: 26 }, bed: { x: 59, y: 24 }, door: { x: 59, y: 23 }, doorSide: "N", plot: { x0: 58, y0: 27, x1: 60, y1: 28 } },
  { id: "lot_n6", house: { x0: 66, y0: 23, x1: 69, y1: 26 }, bed: { x: 67, y: 24 }, door: { x: 67, y: 23 }, doorSide: "N", plot: { x0: 66, y0: 27, x1: 68, y1: 28 } },
  // -- inner-south strip: house bottom row y=49, door faces S onto the y=50
  //    road; plot sits directly above the house. -----------------------------
  { id: "lot_s1", house: { x0: 26, y0: 46, x1: 29, y1: 49 }, bed: { x: 27, y: 48 }, door: { x: 27, y: 49 }, doorSide: "S", plot: { x0: 26, y0: 44, x1: 28, y1: 45 } },
  { id: "lot_s2", house: { x0: 34, y0: 46, x1: 37, y1: 49 }, bed: { x: 35, y: 48 }, door: { x: 35, y: 49 }, doorSide: "S", plot: { x0: 34, y0: 44, x1: 36, y1: 45 } },
  { id: "lot_s3", house: { x0: 41, y0: 46, x1: 44, y1: 49 }, bed: { x: 42, y: 48 }, door: { x: 42, y: 49 }, doorSide: "S", plot: { x0: 41, y0: 44, x1: 43, y1: 45 } },
  { id: "lot_s4", house: { x0: 49, y0: 46, x1: 52, y1: 49 }, bed: { x: 50, y: 48 }, door: { x: 50, y: 49 }, doorSide: "S", plot: { x0: 49, y0: 44, x1: 51, y1: 45 } },
  { id: "lot_s5", house: { x0: 58, y0: 46, x1: 61, y1: 49 }, bed: { x: 59, y: 48 }, door: { x: 59, y: 49 }, doorSide: "S", plot: { x0: 58, y0: 44, x1: 60, y1: 45 } },
  { id: "lot_s6", house: { x0: 66, y0: 46, x1: 69, y1: 49 }, bed: { x: 67, y: 48 }, door: { x: 67, y: 49 }, doorSide: "S", plot: { x0: 66, y0: 44, x1: 68, y1: 45 } },
  // -- spine-adjacent lots: door faces the central spine (y=36). Houses sit just
  //    below the spine in clear grass between the trunks; plot below the house. -
  { id: "lot_p1", house: { x0: 18, y0: 37, x1: 21, y1: 40 }, bed: { x: 19, y: 39 }, door: { x: 19, y: 37 }, doorSide: "N", plot: { x0: 18, y0: 41, x1: 20, y1: 42 } },
  { id: "lot_p2", house: { x0: 66, y0: 37, x1: 69, y1: 40 }, bed: { x: 67, y: 39 }, door: { x: 67, y: 37 }, doorSide: "N", plot: { x0: 66, y0: 41, x1: 68, y1: 42 } },
];

// -- road network ------------------------------------------------------------
// A hand-authored set of road SEGMENTS (each a 1-wide horizontal or vertical
// run, inclusive endpoints) forming a downtown loop around the plaza, the main
// y=20 connector spine, residential spurs each homestead door drops onto, and
// park access. Stamped BEFORE rooms so every door's exterior neighbour is path.

/** main connector path row — the spine the verticals + downtown doors meet. */
const SPINE_Y = 36;
/** north residential road row (north doors' exterior y) */
const NORTH_ROAD_Y = 22;
/** south residential road row (south doors' exterior y) */
const SOUTH_ROAD_Y = 50;

interface RoadSeg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * ROAD_SEGMENTS — every road run in the 96×64 town. Order is irrelevant (they
 * are all stamped to `path`). Authored so: (a) the y=36 spine spans the full
 * interior; (b) two residential roads (north y=22, south y=50) host the twelve
 * homes; (c) eleven evenly-spaced vertical trunks tie both residential rows to
 * the spine so every home column has a near trunk (keeps the door→tavern A*
 * path ≤ 40 even at the band edges); (d) a central downtown plaza row drops the
 * civic doors onto the spine; (e) a park spur reaches the eastern park region.
 *
 * NOTE — the residential roads sit at y=22/y=50 (not the design draft's y=14/
 * y=54): with a centrally-placed tavern the wider y=14/54 separation pushes the
 * band-edge homes past the 40-tile reachability budget (their Manhattan
 * distance alone exceeds it). y=22/y=50 keeps the spine dead-centre, leaves the
 * y<18 / y>54 rim as open countryside, and lets the homes spread x∈[24..70].
 */
export const ROAD_SEGMENTS: RoadSeg[] = [
  // main horizontal connector spine across the full interior.
  { x0: 1, y0: SPINE_Y, x1: MAP_WIDTH - 2, y1: SPINE_Y },
  // north residential road (homes above face S onto y=22)
  { x0: 4, y0: NORTH_ROAD_Y, x1: 92, y1: NORTH_ROAD_Y },
  // south residential road (homes below face N onto y=50)
  { x0: 4, y0: SOUTH_ROAD_Y, x1: 92, y1: SOUTH_ROAD_Y },
  // vertical trunks tying both residential rows to the spine (every 8 cols)
  { x0: 8,  y0: NORTH_ROAD_Y, x1: 8,  y1: SOUTH_ROAD_Y },
  { x0: 16, y0: NORTH_ROAD_Y, x1: 16, y1: SOUTH_ROAD_Y },
  { x0: 24, y0: NORTH_ROAD_Y, x1: 24, y1: SOUTH_ROAD_Y },
  { x0: 32, y0: NORTH_ROAD_Y, x1: 32, y1: SOUTH_ROAD_Y },
  { x0: 40, y0: NORTH_ROAD_Y, x1: 40, y1: SOUTH_ROAD_Y },
  { x0: 48, y0: NORTH_ROAD_Y, x1: 48, y1: SOUTH_ROAD_Y },
  { x0: 56, y0: NORTH_ROAD_Y, x1: 56, y1: SOUTH_ROAD_Y },
  { x0: 64, y0: NORTH_ROAD_Y, x1: 64, y1: SOUTH_ROAD_Y },
  { x0: 72, y0: NORTH_ROAD_Y, x1: 72, y1: SOUTH_ROAD_Y },
  { x0: 80, y0: NORTH_ROAD_Y, x1: 80, y1: SOUTH_ROAD_Y },
  { x0: 88, y0: NORTH_ROAD_Y, x1: 88, y1: SOUTH_ROAD_Y },
  // downtown plaza row (civic door exteriors), one above the spine
  { x0: 34, y0: 35, x1: 58, y1: 35 },
  { x0: 36, y0: 35, x1: 36, y1: 36 }, // shop column joiner to spine
  { x0: 47, y0: 35, x1: 47, y1: 36 }, // tavern column joiner to spine
  { x0: 56, y0: 35, x1: 56, y1: 36 }, // cafe column joiner to spine
  // park access spur (east): drop from the spine up to the park's south edge
  { x0: 78, y0: 24, x1: 78, y1: 36 },
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
  // Tavern: 7×5, dead-centre above the spine; door S onto plaza row y=35.
  { kind: "tavern", rect: { x0: 44, y0: 30, x1: 50, y1: 34 }, door: { x: 47, y: 34 }, doorSide: "S" },
  // Shop: 5×5, west of tavern; door S onto plaza; shopTile centre interior.
  { kind: "shop", rect: { x0: 34, y0: 30, x1: 38, y1: 34 }, door: { x: 36, y: 34 }, doorSide: "S", specialTile: { x: 36, y: 32 } },
  // Cafe: 5×4, east of tavern; door S onto plaza.
  { kind: "cafe", rect: { x0: 54, y0: 31, x1: 58, y1: 34 }, door: { x: 56, y: 34 }, doorSide: "S" },
  // Office: 5×5, below the spine; door N onto the spine (exterior y=36).
  { kind: "office", rect: { x0: 40, y0: 37, x1: 44, y1: 41 }, door: { x: 42, y: 37 }, doorSide: "N" },
  // School: 6×5, below-right of the spine; door N onto the spine.
  { kind: "school", rect: { x0: 50, y0: 37, x1: 55, y1: 41 }, door: { x: 52, y: 37 }, doorSide: "N" },
];

const SHOP_SPEC = COMMONS.find((c) => c.kind === "shop")!;
const SHOP_TILE: Vec2 = { ...SHOP_SPEC.specialTile! };

// -- park --------------------------------------------------------------------
// An open green region (NOT a walled room): mostly walkable grass with an inner
// pond (water) and a few benches/trees. Sits in the open SE flat, clear of the
// rooms and roads. The pond is ≥4 wide with grass flanks (pathfinding pond
// detour test). WATER_POS is the pond's NW corner.
export const PARK = { x0: 74, y0: 24, x1: 84, y1: 34 };
/** Inner pond: exactly 4 wide (x0..x0+3), grass border inside the park region.
 *  The 4-wide invariant is load-bearing — tests/world/pathfinding.test.ts derives
 *  the pond's east grass flank as WATER_POS.x + 4 (= x1 + 1). */
const POND = { x0: 77, y0: 27, x1: 80, y1: 30 };

// -- v3: world object positions (plaza + park) -------------------------------
// Well: on the central plaza row, west of the tavern.
export const WELL_POS: Vec2 = { x: 41, y: 35 };
// Notice board: one step east of the well (same row) — objects.test geometry
// pins board = well + (1,0).
export const NOTICE_BOARD_POS: Vec2 = { x: 42, y: 35 };
// Bench: on park grass immediately west of the pond (adjacent to water).
export const BENCH_POS: Vec2 = { x: 75, y: 28 };
// A second bench INSIDE the park (typology park-bench test), east of the pond.
const PARK_BENCH_POS: Vec2 = { x: 83, y: 28 };

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

  // Decorative ground cover — deterministic (zero RNG), dense and layered so the
  // 96x64 town reads as a lush, lived-in place rather than bare lawn. Four kinds
  // by descending size: clustered trees (forest feel) > bushes > flowers > grass
  // tufts. Each kind uses a distinct coprime hash so the layers never align into
  // visible stripes. One decor item per grass tile (priority tree>bush>flower>
  // grass via early-continue). `variant` indexes the renderer's per-kind frames.
  const decor: DecorItem[] = [];
  const isGrass = (gx: number, gy: number): boolean =>
    gy >= 0 && gy < MAP_HEIGHT && gx >= 0 && gx < MAP_WIDTH && tiles[gy][gx] === "grass";
  const clearCanopy = (gx: number, gy: number): boolean =>
    isGrass(gx, gy) && isGrass(gx - 1, gy) && isGrass(gx + 1, gy) && isGrass(gx, gy - 1) && isGrass(gx, gy + 1);
  for (let y = 1; y < MAP_HEIGHT - 1; y++) {
    for (let x = 1; x < MAP_WIDTH - 1; x++) {
      if (!isGrass(x, y)) continue;
      // Trees: need a clear canopy neighbourhood, biased into sparse "forest"
      // cells so they clump at the rural edges instead of dotting lawns evenly.
      if (clearCanopy(x, y)) {
        const forestCell = (((x / 6) | 0) * 13 + ((y / 6) | 0) * 29) % 7 === 0;
        const treeHit = forestCell ? (x * 11 + y * 7) % 6 === 0 : (x * 11 + y * 7) % 31 === 0;
        if (treeHit) { decor.push({ kind: "tree", pos: { x, y }, variant: (x + y) % 2 }); continue; }
      }
      if ((x * 17 + y * 5) % 23 === 0) { decor.push({ kind: "bush", pos: { x, y }, variant: (x * 3 + y) % 3 }); continue; }
      if ((x * 5 + y * 11) % 11 === 0) { decor.push({ kind: "flower", pos: { x, y }, variant: (x + y * 2) % 4 }); continue; }
      if ((x * 13 + y * 3) % 8 === 0) { decor.push({ kind: "grass", pos: { x, y }, variant: (x + y) % 3 }); continue; }
    }
  }
  // Guarantee at least one tree INSIDE the park region (typology park test).
  const parkTree: Vec2 = { x: PARK.x0, y: PARK.y0 + 1 };
  if (isGrass(parkTree.x, parkTree.y) && !decor.some((d) => d.pos.x === parkTree.x && d.pos.y === parkTree.y)) {
    decor.push({ kind: "tree", pos: { ...parkTree }, variant: 0 });
  }

  return { width: MAP_WIDTH, height: MAP_HEIGHT, tiles, landmarks, decor, objects: WORLD_OBJECTS.map((o) => ({ ...o, pos: { ...o.pos } })) };
}

// Internal helpers exported for tests that derive structure (not coordinates).
export { exteriorOf };
export type { DoorSide, HomesteadSpec, CommonsSpec, CommonsKind };
export { COMMONS, SPINE_Y, POND };
