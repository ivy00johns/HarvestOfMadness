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
