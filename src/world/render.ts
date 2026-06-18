/**
 * RenderApi access point. WorldScene calls setRenderApi(this) in create();
 * agent-pipeline code imports getRenderApi() — no circular imports, and a
 * null return simply means the scene is not booted yet (callers may no-op).
 */
import type { RenderApi } from "@contracts/types";

let current: RenderApi | null = null;

export function setRenderApi(api: RenderApi | null): void {
  current = api;
}

export function getRenderApi(): RenderApi | null {
  return current;
}

// ---------------------------------------------------------------------------
// Pure LPC frame-mapping helpers (no Phaser — unit-testable headless).
// Frame indices are verified against the committed sheets in public/assets.
// ---------------------------------------------------------------------------

/**
 * water_tiles.png — 96x192, 3 frames/row. Rows 2-4 are a 3x3 dirt-shored
 * pond block (corners/edges/center); row 5 holds the 3 open-water animation
 * frames. Edge tiles are part-transparent, so grass is drawn beneath.
 */
export const WATER_FRAMES = {
  TL: 6, T: 7, TR: 8,
  L: 9, C: 10, R: 11,
  BL: 12, B: 13, BR: 14,
  ANIM: [15, 16, 17] as readonly number[],
} as const;

/**
 * plowed_soil.png — 96x192, 3 frames/row. Rows 2-4 are a 3x3 grass-edged
 * soil block (the untilled field, picked by neighbour mask); frame 16 is
 * the furrowed "tilled" tile.
 */
export const SOIL_FRAMES = {
  TL: 6, T: 7, TR: 8,
  L: 9, C: 10, R: 11,
  BL: 12, B: 13, BR: 14,
  TILLED: 16,
} as const;

/** fence.png — 96x192, 3 frames/row. */
export const FENCE_FRAMES = {
  /** horizontal rail (top wall row) */
  H: 1,
  /** post + vertical pole (side wall columns) */
  V: 4,
  /** lone post (corners) */
  POST: 3,
  /** horizontal rail with legs (bottom wall row) */
  H_LEGS: 13,
} as const;

/**
 * PathAndObjects.png — 16 frames/row. The path autotiles live in cols 0-11;
 * rows 3-4 are the seamless full-bleed fill (no grass border) that tiles
 * cleanly along a 1-wide road. Frames 48 and 50 are clean grey cobblestone
 * (49 carries a decorative grass tuft, omitted so roads read uniform).
 */
export const COBBLE_PATH_FRAMES: readonly number[] = [48, 50];

/**
 * decorations-medieval.png — 16 frames/row. Stone well (cols 0-1) as a 2-wide
 * block: rim row (rows 13), body row (row 14). frame = row*16 + col.
 */
export const WELL_FRAMES = {
  RIM_L: 208, RIM_R: 209, // row 13: circular stone rim top
  BODY_L: 224, BODY_R: 225, // row 14: stone body with the bucket opening
} as const;

/**
 * decorations-medieval.png hanging signs (rows 0-1). Single 32×32 boards that
 * hang from a top bar — used for the notice board and shop/tavern signage.
 */
export const SIGN_FRAMES = {
  BOARD: 6, // plain wooden board (notice board / office)
  JUG: 8, // jug/tankard — cafe (Wave 5a, row 0)
  BREAD: 9, // loaf — general store / shop
  BOOK: 22, // book — school (Wave 5a, row 1)
  BEER: 23, // tankard — tavern
} as const;

/**
 * decorations-medieval.png lit lanterns/torches (manifest: cols 12-15). The
 * lit-glow pair LIT/LIT_ALT are adjacent columns 12/13 on the same sheet row.
 * frame = row*16 + col. Row 2 is the eyeball-confirmed glow row; the unit test
 * pins only the col band (12-15) + adjacency, so a future row tweak won't
 * redden the suite.
 */
export const LANTERN_FRAMES = {
  LIT: 12 + 16 * 2, // 44 — col 12, row 2
  LIT_ALT: 13 + 16 * 2, // 45 — col 13, row 2
} as const;

/**
 * interior.png — 16 frames/row. Open-roof room rendering: a back-wall strip and
 * a few built-in furnishings. frame = row*16 + col.
 *
 * NOTE on the floor: interior.png's only floor tiles are frame 64 (a blue-grey/
 * tan two-tone STONE tile) and 65 (green cobble). Tiled across a room, frame 64
 * reads as an ugly checkerboard, so interior FLOORS are now drawn from the
 * dedicated warm wood-plank sheet (INTERIOR_FLOOR_TEXTURE) instead — see
 * WorldScene.drawTileAssets. FLOOR is retained as a valid sheet index (still the
 * documented stone tile) but is no longer used for floor fill.
 */
export const INTERIOR_FRAMES = {
  FLOOR: 64, // c0r4 — stone/tile floor (legacy; checkerboard — superseded by wood floor)
  // Back wall as a framed row: top-left corner, top edge, top-right corner.
  // (frame 1 is a broken-wall hole — never use it.) Indexed left→right.
  WALL: [0, 2, 4] as readonly number[],
  SHELF: 96, // c0r6 — bookshelf
  CABINET: 98, // c2r6 — cabinet
  BAR: 100, // c4r6 — counter unit (tavern bar)
  BARREL: 129, // c1r8 — barrel stack
} as const;

/**
 * Warm wood-plank interior floor. interior.png ships no clean wood floor (only
 * the checkerboard stone tile), so a single seamless 32×32 warm-wood-plank tile
 * lives in its own sheet (manifest key "interior_floor"). It is a 1×1 sheet, so
 * the whole tile is frame 0. Tone matches the manifest's intended floor colour
 * (TILE_COLORS.floor = 0x8b6f47). Used for floor / bedTile / shopTile interior
 * cells. CC0 (authored for this project) — see public/assets/CREDITS.md.
 */
export const INTERIOR_FLOOR_TEXTURE = "interior_floor";
export const INTERIOR_FLOOR_FRAME = 0;

/**
 * Warm wood-plank interior WALL ring. interior.png's row-0 wall frames are
 * open-roof ceiling-edge pieces with large black voids — tiled as a full wall
 * ring they read as dark "gold/odd blocks". A single seamless 32×32 timber-wall
 * tile (manifest key "interior_wall") replaces them: a tidy vertical-plank wall
 * a few shades deeper than the floor, so a room reads as walls + floor. 1×1
 * sheet (whole tile = frame 0). CC0 (authored) — see public/assets/CREDITS.md.
 */
export const INTERIOR_WALL_TEXTURE = "interior_wall";
export const INTERIOR_WALL_FRAME = 0;

/**
 * blonde-wood.png furniture — 16 frames/row. A double bed (2×2 block) and a
 * round table for furnishing houses / the tavern.
 */
export const FURNITURE_FRAMES = {
  BED_HEAD_L: 208, BED_HEAD_R: 209, // r13 — pillow end
  BED_FOOT_L: 224, BED_FOOT_R: 225, // r14 — foot end
  TABLE_ROUND: 125, // c13r7 — small round table
  TABLE_SMALL: 124, // c12r7 — small square table (extra tavern/house table)
  CHAIR_L: 110, // c14r6 — chair facing right (paired left of a table)
  CHAIR_R: 111, // c15r6 — chair facing left (paired right of a table)
} as const;

/** 4-neighbour membership probe: same-type checks at (±1,0)/(0,±1). */
export type NeighborProbe = (dx: number, dy: number) => boolean;

/** Map crop progress onto the 5-frame growth strip (frame 4 = ready). */
export function cropStripFrame(
  stage: number,
  days: number,
  ready: boolean,
): number {
  if (ready) return 4;
  return Math.max(0, Math.min(3, Math.floor((stage / days) * 4)));
}

/**
 * Pond frame by 4-neighbour water mask: fully surrounded tiles are open
 * (animated) water, everything else picks from the 3x3 shore block.
 */
export function waterFrame(isWater: NeighborProbe): number {
  const n = isWater(0, -1);
  const s = isWater(0, 1);
  const w = isWater(-1, 0);
  const e = isWater(1, 0);
  if (n && s && w && e) return WATER_FRAMES.ANIM[0];
  if (!n) return !w ? WATER_FRAMES.TL : !e ? WATER_FRAMES.TR : WATER_FRAMES.T;
  if (!s) return !w ? WATER_FRAMES.BL : !e ? WATER_FRAMES.BR : WATER_FRAMES.B;
  return !w ? WATER_FRAMES.L : !e ? WATER_FRAMES.R : WATER_FRAMES.C;
}

/** Field frame by 4-neighbour membership (soil and tilled both count). */
export function soilFrame(isField: NeighborProbe): number {
  const n = isField(0, -1);
  const s = isField(0, 1);
  const w = isField(-1, 0);
  const e = isField(1, 0);
  if (!n) return !w ? SOIL_FRAMES.TL : !e ? SOIL_FRAMES.TR : SOIL_FRAMES.T;
  if (!s) return !w ? SOIL_FRAMES.BL : !e ? SOIL_FRAMES.BR : SOIL_FRAMES.B;
  return !w ? SOIL_FRAMES.L : !e ? SOIL_FRAMES.R : SOIL_FRAMES.C;
}

/** Wall-ring fence piece for tile (x,y) on a w×h map (impassable border). */
export function fenceFrame(
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const corner = (x === 0 || x === width - 1) && (y === 0 || y === height - 1);
  if (corner) return FENCE_FRAMES.POST;
  if (y === 0) return FENCE_FRAMES.H;
  if (y === height - 1) return FENCE_FRAMES.H_LEGS;
  return FENCE_FRAMES.V;
}

// ---------------------------------------------------------------------------
// Decorative ground cover (DecorItem kinds → concrete sprite). Pure mapping so
// the WorldScene placement stays a thin blit and the frame choices are unit-
// testable. Frame indices are tuned against the committed sheets via a render
// screenshot; keep them here so a sheet swap is a one-line change.
// ---------------------------------------------------------------------------

/**
 * Per-kind decor frames + render layer.
 *  - tree:  fruit-trees sheet (tall, bottom-anchored, canopy OVER agents)
 *  - bush:  plants.png leafy shrubs (occlude by y, like crops)
 *  - flower:plants.png small colourful plants (flat, under agents)
 *  - grass: tallgrass.png tufts (flat, under agents)
 */
export const DECOR_FRAMES = {
  tree: { texture: "fruit_trees", frames: [0, 10] as readonly number[], layer: "overhead" },
  bush: { texture: "plants", frames: [28, 37, 46] as readonly number[], layer: "ysort" },
  flower: { texture: "plants", frames: [99, 100, 101, 102] as readonly number[], layer: "ground" },
  grass: { texture: "tallgrass", frames: [15, 16, 17] as readonly number[], layer: "ground" },
} as const;

export type DecorLayer = "overhead" | "ysort" | "ground";

export interface DecorSprite {
  texture: string;
  frame: number;
  layer: DecorLayer;
}

/** Resolve a decor kind + variant to a concrete sprite. Variant wraps the list. */
export function decorSprite(
  kind: keyof typeof DECOR_FRAMES,
  variant: number,
): DecorSprite {
  const spec = DECOR_FRAMES[kind];
  const n = spec.frames.length;
  const frame = spec.frames[((variant % n) + n) % n];
  return { texture: spec.texture, frame, layer: spec.layer as DecorLayer };
}
