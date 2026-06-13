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
 * Render zoom (integer). v2: TILE_SIZE is 32 so the logical canvas is already
 * 768x576 (24*32 x 18*32) — shown at x1 and FIT-scaled to the window.
 */
export const GAME_ZOOM = 1;

/** Page / letterbox background. */
export const BACKGROUND_COLOR = "#101014";

/** Placeholder tile colors (zero-asset fallback rendering). */
export const TILE_COLORS: Record<TileType, number> = {
  grass: 0x3e7c3a,
  path: 0xb89b6a,
  water: 0x2a6fb0,
  tilled: 0x4a2f1d, // dark brown
  soil: 0x8a6a45,
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
export const SPEECH_MAX_CHARS = 60;

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
