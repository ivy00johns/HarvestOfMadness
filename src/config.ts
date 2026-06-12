/**
 * Harvest of Madness — client configuration constants.
 *
 * Pure data: no Phaser imports (world logic + tests depend on this file).
 * Contract-authoritative values (map size, tile size, crop tables) live in
 * @contracts/types — re-exported here for convenience.
 */
import type { TileType } from "@contracts/types";

export {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  CROPS,
  /** Contract v1.2: real-time length of one phase at speed 1 (8s). */
  PHASE_DURATION_MS,
} from "@contracts/types";

/** Render zoom: logical 384x288 shown at x2. */
export const GAME_ZOOM = 2;

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
