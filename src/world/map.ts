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
 * tavern sits dead-centre on the spine so every homestead reaches it within the
 * ≤ 100 A* reachability floor (see tests/agents/party-emergence.test.ts).
 *
 * A horizontal main-connector path row at y=50 (the spine) spans the interior;
 * the civic doors and the three vertical trunks open onto it. Divergence is spatial:
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
 * TWELVE TWO-ROOM homesteads in four corner HAMLETS (3 homes each) around the
 * central civic hub (Option C 140×100 re-lay). Each is a 5×6/5×7 cottage with a
 * vertical interior divider + doorway gap (see stampHomestead), a door facing a
 * residential road (north y=20 / south y=80), and a soil plot beside the door.
 * Every door stays within the ≤100 A* tavern-reachability floor (corner homes
 * sit ~90–96 tiles from the central tavern). One bed + one house landmark per
 * home → the 12-bed / 12-house landmark contract.
 */
export const HOMESTEADS: HomesteadSpec[] = [
  // FOUR corner HAMLETS (3 homes each). Each home is a 5×6 two-room cottage
  // (stampHomestead adds a vertical divider + doorway gap). Doors face the
  // nearest residential road (north y=20 / south y=80) so each door's exterior
  // neighbour is a path tile. Side plots sit within OBSERVATION_RADIUS of the
  // door. brix is HOMESTEADS[0] → its plot is FIELD_RECT; it extends DOWN to
  // y=19 so a soil cell at y=19 borders the north road y=20 (the executor
  // TILL-rejects-road fixture).
  // -- NW hamlet (doors onto the north road y=20) --
  { id: "brix", house: { x: 7,  y: 14 }, size: { w: 5, h: 6 }, bed: { x: 9,  y: 16 }, door: { x: 9,  y: 19 }, doorSide: "S", plot: { x0: 12, y0: 15, x1: 14, y1: 19 } },
  { id: "ford", house: { x: 16, y: 14 }, size: { w: 5, h: 6 }, bed: { x: 18, y: 16 }, door: { x: 18, y: 19 }, doorSide: "S", plot: { x0: 21, y0: 15, x1: 23, y1: 18 } },
  // wren/clem/sage/zola are 5×7 (a row taller than their 5×6 hamlet-mates) so
  // the town spans ≥2 distinct house sizes (the organic-layout invariant).
  { id: "wren", house: { x: 9,  y: 21 }, size: { w: 5, h: 7 }, bed: { x: 11, y: 24 }, door: { x: 11, y: 21 }, doorSide: "N", plot: { x0: 14, y0: 22, x1: 16, y1: 25 } },
  // -- NE hamlet (doors onto the north road y=20) --
  { id: "dora", house: { x: 118, y: 14 }, size: { w: 5, h: 6 }, bed: { x: 120, y: 16 }, door: { x: 120, y: 19 }, doorSide: "S", plot: { x0: 123, y0: 16, x1: 125, y1: 19 } },
  { id: "gus",  house: { x: 127, y: 14 }, size: { w: 5, h: 6 }, bed: { x: 129, y: 16 }, door: { x: 129, y: 19 }, doorSide: "S", plot: { x0: 132, y0: 16, x1: 134, y1: 19 } },
  { id: "clem", house: { x: 121, y: 21 }, size: { w: 5, h: 7 }, bed: { x: 123, y: 24 }, door: { x: 123, y: 21 }, doorSide: "N", plot: { x0: 126, y0: 22, x1: 128, y1: 25 } },
  // -- SW hamlet (doors onto the south road y=80) --
  { id: "fern", house: { x: 7,  y: 74 }, size: { w: 5, h: 6 }, bed: { x: 9,  y: 76 }, door: { x: 9,  y: 79 }, doorSide: "S", plot: { x0: 12, y0: 75, x1: 14, y1: 78 } },
  { id: "nell", house: { x: 16, y: 74 }, size: { w: 5, h: 6 }, bed: { x: 18, y: 76 }, door: { x: 18, y: 79 }, doorSide: "S", plot: { x0: 21, y0: 75, x1: 23, y1: 78 } },
  { id: "sage", house: { x: 9,  y: 81 }, size: { w: 5, h: 7 }, bed: { x: 11, y: 84 }, door: { x: 11, y: 81 }, doorSide: "N", plot: { x0: 14, y0: 82, x1: 16, y1: 85 } },
  // -- SE hamlet (doors onto the south road y=80) --
  { id: "rusty", house: { x: 118, y: 74 }, size: { w: 5, h: 6 }, bed: { x: 120, y: 76 }, door: { x: 120, y: 79 }, doorSide: "S", plot: { x0: 123, y0: 75, x1: 125, y1: 78 } },
  { id: "moss",  house: { x: 127, y: 74 }, size: { w: 5, h: 6 }, bed: { x: 129, y: 76 }, door: { x: 129, y: 79 }, doorSide: "S", plot: { x0: 132, y0: 75, x1: 134, y1: 78 } },
  { id: "zola",  house: { x: 121, y: 81 }, size: { w: 5, h: 7 }, bed: { x: 123, y: 84 }, door: { x: 123, y: 81 }, doorSide: "N", plot: { x0: 126, y0: 82, x1: 128, y1: 85 } },
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
 * The original fourteen lots have all been PROMOTED into occupied HOMESTEADS
 * (the 26-townsfolk expansion), so this array is now empty. The type + export
 * are retained so future capacity can be reserved again with no re-survey.
 */
export interface ReserveLot {
  id: string;
  house: { x0: number; y0: number; x1: number; y1: number };
  bed: Vec2;
  door: Vec2;
  doorSide: DoorSide;
  plot: { x0: number; y0: number; x1: number; y1: number };
}

export const RESERVE_LOTS: ReserveLot[] = [];

// -- road network ------------------------------------------------------------
// A hand-authored set of road SEGMENTS (each a 1-wide horizontal or vertical
// run, inclusive endpoints) forming a downtown loop around the plaza, the main
// y=20 connector spine, residential spurs each homestead door drops onto, and
// park access. Stamped BEFORE rooms so every door's exterior neighbour is path.

/** main connector path row — the spine the verticals + downtown doors meet. */
const SPINE_Y = 50;
/** north residential road row (north doors' exterior y) */
const NORTH_ROAD_Y = 20;
/** south residential road row (south doors' exterior y) */
const SOUTH_ROAD_Y = 80;

interface RoadSeg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * ROAD_SEGMENTS — every road run in the 140×100 town (Option C civic-hub layout).
 * Order is irrelevant (all stamped to `path`). Six runs: (a) the y=50 spine spans
 * the full interior and the five civic doors open directly onto it; (b) two
 * residential roads (north y=20, south y=80) host the four corner hamlets;
 * (c) three vertical trunks (x=24/70/116) tie both residential roads to the spine.
 *
 * The residential roads run x∈[7..132] (wider than the design draft's [10..130])
 * so the westmost doors (brix {9,19}, fern {9,79}) and the eastmost columns
 * (gus/moss {129,..}) land their exteriors on the road. The map rim and the empty
 * central road stretches are left as countryside / future-hamlet ground.
 */
export const ROAD_SEGMENTS: RoadSeg[] = [
  // main horizontal connector spine across the full interior (y=50).
  { x0: 6, y0: SPINE_Y, x1: 134, y1: SPINE_Y },
  // north residential road (NW + NE hamlet doors open onto y=20).
  // West end at x=7 (not the draft's x=10) so the brix door {9,19} exterior
  // {9,20} lands on the road; east end at x=132 so gus's door column is covered.
  { x0: 7, y0: NORTH_ROAD_Y, x1: 132, y1: NORTH_ROAD_Y },
  // south residential road (SW + SE hamlet doors open onto y=80). Same x span
  // so the fern {9,79} / rusty doors' exteriors land on the road.
  { x0: 7, y0: SOUTH_ROAD_Y, x1: 132, y1: SOUTH_ROAD_Y },
  // three vertical trunks tying the north + south roads to the spine.
  { x0: 24,  y0: NORTH_ROAD_Y, x1: 24,  y1: SOUTH_ROAD_Y }, // west trunk
  { x0: 70,  y0: NORTH_ROAD_Y, x1: 70,  y1: SOUTH_ROAD_Y }, // center trunk
  { x0: 116, y0: NORTH_ROAD_Y, x1: 116, y1: SOUTH_ROAD_Y }, // east trunk
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
 * COMMONS — the five civic rooms straddling the central spine (y=50). Doors all
 * open onto the spine. The tavern is dead-centre so every homestead door is
 * ≤ 100 A* tiles away (party-emergence reachability gate).
 */
// LARGE civic buildings (Smallville-scale rooms with space for aisles, desk
// rows and full furnishing). The dead-centre tavern keeps the party-emergence
// reachability floor (≤100 A* door→tavern) satisfied for the four corner
// hamlets; shop/cafe sit west/east above the spine, school/office below it. They straddle a few
// vertical road trunks, but the spine + the other trunks keep the town connected.
const COMMONS: CommonsSpec[] = [
  // Supermarket: 8×7 above the spine; door S onto the spine (ext y=50); shopTile gate.
  { kind: "shop", rect: { x0: 50, y0: 43, x1: 57, y1: 49 }, door: { x: 53, y: 49 }, doorSide: "S", specialTile: { x: 53, y: 46 } },
  // Tavern: 9×8, dead-centre above the spine; door S onto the spine (ext y=50).
  // The tavern door is the party-emergence reachability anchor.
  { kind: "tavern", rect: { x0: 62, y0: 42, x1: 70, y1: 49 }, door: { x: 66, y: 49 }, doorSide: "S" },
  // Cafe: 7×6, east of the tavern; door S onto the spine.
  { kind: "cafe", rect: { x0: 73, y0: 44, x1: 79, y1: 49 }, door: { x: 76, y: 49 }, doorSide: "S" },
  // School: 9×8, below the spine; door N onto the spine (ext y=50).
  { kind: "school", rect: { x0: 60, y0: 51, x1: 68, y1: 58 }, door: { x: 64, y: 51 }, doorSide: "N" },
  // Office / town hall: 8×7, below-right of the spine; door N onto the spine.
  { kind: "office", rect: { x0: 72, y0: 51, x1: 79, y1: 57 }, door: { x: 75, y: 51 }, doorSide: "N" },
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
// Well: on the central plaza between the shop (x≤57) and the tavern (x≥62),
// its south edge on the spine path (y=49 floor row → ext y=50 spine).
export const WELL_POS: Vec2 = { x: 59, y: 49 };
// Notice board: one step east of the well (same row) — objects.test geometry
// pins board = well + (1,0).
export const NOTICE_BOARD_POS: Vec2 = { x: 60, y: 49 };
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
  // TWO-ROOM split: a vertical interior wall with a single doorway gap divides
  // the home into two rooms (Smallville-style). The divider sits between the
  // door's room and the bed's room; the gap (kept `floor`) connects them so the
  // bed stays reachable. Skipped for any home too small to hold a divider.
  if (h.size.w >= 5 && h.size.h >= 4) {
    const dcol = h.house.x + Math.ceil(h.size.w / 2);
    const gapRow = h.house.y + Math.floor(h.size.h / 2);
    for (let y = h.house.y + 1; y <= y1 - 1; y++) {
      if (y !== gapRow) tiles[y][dcol] = "wall";
    }
  }
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
  // landmarks (10 each).
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
  // 140x100 town reads as a lush, lived-in place rather than bare lawn. Four kinds
  // by descending size: clustered trees (forest feel) > bushes > flowers > grass
  // tufts. Each kind uses a distinct coprime hash so the layers never align into
  // visible stripes. One decor item per grass tile (priority tree>bush>flower>
  // grass via early-continue). `variant` indexes the renderer's per-kind frames.
  const decor: DecorItem[] = [];
  const isGrass = (gx: number, gy: number): boolean =>
    gy >= 0 && gy < MAP_HEIGHT && gx >= 0 && gx < MAP_WIDTH && tiles[gy][gx] === "grass";
  // Building tile (room interior or wall) — a tree canopy over one of these
  // reads as a tree growing out of the roof (the open-roof cutaway shows it).
  const isBuilding = (gx: number, gy: number): boolean => {
    if (gy < 0 || gy >= MAP_HEIGHT || gx < 0 || gx >= MAP_WIDTH) return false;
    const t = tiles[gy][gx];
    return t === "wall" || t === "floor" || t === "bedTile" || t === "shopTile";
  };
  // Fruit-tree sprites are 96×128 (3 tiles wide × 4 tall), bottom-anchored, so a
  // tree at (gx,gy) paints the box cols gx-1..gx+1 × rows gy-3..gy. Place a tree
  // only where its trunk sits on open grass AND that whole canopy box is clear of
  // any building — otherwise the canopy overhangs a roof (the "tree in the cafe").
  const clearCanopy = (gx: number, gy: number): boolean => {
    if (!(isGrass(gx, gy) && isGrass(gx - 1, gy) && isGrass(gx + 1, gy) &&
      isGrass(gx, gy - 1) && isGrass(gx, gy + 1))) return false;
    for (let cy = gy - 3; cy <= gy; cy++) {
      for (let cx = gx - 1; cx <= gx + 1; cx++) {
        if (isBuilding(cx, cy)) return false;
      }
    }
    return true;
  };
  // Grass tile that touches a soil plot — keep the showier decor (bushes,
  // flowers) OFF these so fields read with clean borders instead of being
  // "fenced" by a ring of scatter.
  const bordersField = (gx: number, gy: number): boolean =>
    tiles[gy][gx - 1] === "soil" || tiles[gy][gx + 1] === "soil" ||
    tiles[gy - 1][gx] === "soil" || tiles[gy + 1][gx] === "soil";
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
      const edge = bordersField(x, y);
      if (!edge && (x * 17 + y * 5) % 23 === 0) { decor.push({ kind: "bush", pos: { x, y }, variant: (x * 3 + y) % 3 }); continue; }
      // Flowers: DIAGONAL coprime hash (mod 13, both multipliers nonzero mod 13)
      // so blossoms scatter naturally — the old (·)%11 with an ×11 term collapsed
      // to x≡0 (mod 11), planting flowers in vertical COLUMNS that read as fences.
      if (!edge && (x * 7 + y * 5) % 13 === 0) { decor.push({ kind: "flower", pos: { x, y }, variant: (x + y * 2) % 4 }); continue; }
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
