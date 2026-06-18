/**
 * Harvest of Madness — client configuration constants.
 *
 * Pure data: no Phaser imports (world logic + tests depend on this file).
 * Contract-authoritative values (map size, tile size, crop tables) live in
 * @contracts/types — re-exported here for convenience.
 */
import type { Emotion, TileType } from "@contracts/types";

export {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  CROPS,
  /** Contract v1.2: real-time length of one phase at speed 1 (8s). */
  PHASE_DURATION_MS,
} from "@contracts/types";

/**
 * Default spectator camera zoom. The map is 64×40 tiles (2048×1280 world px).
 * At DEFAULT_ZOOM=1.5 a typical 1440-wide viewport shows ~24 tiles across —
 * agents and buildings are readable. GAME_ZOOM is kept as an alias so existing
 * code that imports it still compiles; new code should prefer DEFAULT_ZOOM.
 */
export const DEFAULT_ZOOM = 1.5;
/** @deprecated prefer DEFAULT_ZOOM */
export const GAME_ZOOM = DEFAULT_ZOOM;

/**
 * Spectator camera zoom clamp.
 * MIN is set near the fit-to-map value for the 64×40 world on typical viewports
 * (~0.6) so the player can zoom out to see the whole town without endless void.
 * MAX stays at 3 — good for close-up inspection.
 */
export const CAMERA_ZOOM_MIN = 0.6;
export const CAMERA_ZOOM_MAX = 3;

/**
 * Wheel zoom sensitivity (exponential).  Formula: factor = exp(-dy * S).
 * At S=0.0015 a single mouse-wheel notch (dy≈±100) yields factor≈1.16 (zoom in)
 * or ≈0.86 (zoom out) — noticeable but not jarring.  A small trackpad tick
 * (dy≈±10) gives ≈1.015 — imperceptibly smooth.
 * The old CAMERA_ZOOM_STEP (fixed ×1.1 per ANY wheel event) is removed; this
 * helper scales proportionally to delta magnitude so fast scrolls still move
 * quickly but single notches are gentle.
 */
export const ZOOM_WHEEL_SENSITIVITY = 0.0015;

/**
 * Pure helper — delta-proportional zoom factor for a wheel event.
 * dy > 0  → scroll down → zoom OUT (factor < 1).
 * dy < 0  → scroll up  → zoom IN  (factor > 1).
 * dy = 0  → no change  (factor = 1).
 * Tunable via the sensitivity constant; safe to unit-test with no Phaser dep.
 */
export function zoomFactorForWheelDelta(
  dy: number,
  sensitivity = ZOOM_WHEEL_SENSITIVITY,
): number {
  return Math.exp(-dy * sensitivity);
}

/** Keyboard pan speed (world px/sec at zoom 1, scaled by 1/zoom).
 *  Raised from 480→720 for the larger 64×40 map so panning the full width
 *  still takes a comfortable ~3s at zoom 1.
 */
export const CAMERA_PAN_SPEED = 720;

/** Camera follow lerp (per-axis) when tracking a clicked agent. */
export const CAMERA_FOLLOW_LERP = 0.12;

/** Page / letterbox background. */
export const BACKGROUND_COLOR = "#101014";

/** Placeholder tile colors (zero-asset fallback rendering). */
export const TILE_COLORS: Record<TileType, number> = {
  grass: 0x3e7c3a,
  path: 0xb89b6a,
  water: 0x2a6fb0,
  tilled: 0x4a2f1d, // dark brown
  soil: 0x8a6a45,
  floor: 0x8b6f47, // warm wood — walkable indoor floor
  building: 0x6e5340,
  bedTile: 0xc06080,
  shopTile: 0xd8a83c,
  wall: 0x44444c,
};

/** Crop marker colors per kind (dot drawn on the tile). */
export const CROP_COLORS: Record<string, number> = {
  parsnip: 0xe8d9a0,
  potato: 0xc9a36b,
  cauliflower: 0xe6eef0,
};

/** Gold dot when a crop is ready to harvest. */
export const CROP_READY_COLOR = 0xffd700;

/** Tint overlay on watered crop tiles. */
export const WATERED_TINT = 0x2b4a66;

/** Speech bubble lifetime + truncation (RenderApi.showSpeech). */
export const SPEECH_DURATION_MS = 4_000;
/** Bubble text cap — high enough that a sentence or two of LLM dialogue isn't
 *  clipped; the bubble wraps (see RenderApi.showSpeech) so it grows in height. */
export const SPEECH_MAX_CHARS = 160;

/** Agent walk tween: ms per tile at speed 1 (divided by speed multiplier). */
export const WALK_MS_PER_TILE = 200;

// ---------------------------------------------------------------------------
// v2 — LPC asset rendering (BootScene/WorldScene)
// ---------------------------------------------------------------------------

/** Phaser registry keys set by BootScene, read by WorldScene. */
export const REG_ASSETS_ON = "assetsOn";
export const REG_ASSET_MANIFEST = "assetManifest";

/** Animated open-water frame cycle period (~600ms/frame, 3 frames). */
export const WATER_ANIM_MS = 600;

/** Multiplicative tint that visibly darkens a watered tilled tile. */
export const WATERED_SOIL_TINT = 0x9a8068;

/** Contract rule 14: minimum effective 12px text at zoom 1. */
export const LABEL_FONT_SIZE = 12;
export const SPEECH_FONT_SIZE = 12;

/** RenderApi.playEmote lifetime. */
export const EMOTE_DURATION_MS = 2_000;

/** Per-emotion emote symbol + color (playEmote) / bubble border (showSpeech). */
export const EMOTION_STYLE: Record<
  Emotion,
  { symbol: string; color: number; cssColor: string }
> = {
  happy: { symbol: "♪", color: 0xffd54f, cssColor: "#ffd54f" },
  annoyed: { symbol: "!", color: 0xff5252, cssColor: "#ff5252" },
  sad: { symbol: "…", color: 0x64b5f6, cssColor: "#64b5f6" },
  excited: { symbol: "★", color: 0xffa726, cssColor: "#ffa726" },
  neutral: { symbol: "·", color: 0xe0e0e0, cssColor: "#e0e0e0" },
};
