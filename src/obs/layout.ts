/**
 * HUD layout math — pure (no Phaser), so contract rule 14 ("minimum effective
 * 12px at zoom 1, integer pixel positions") is unit-testable headlessly.
 *
 * Logical canvas is the v2 map: 24*32 x 18*32 = 768x576. The v1 HUD was laid
 * out for the 384x288 (16px-tile) canvas and kept 6-7px fonts — the
 * "unreadable" failure. v2 restructures: a wider right-hand card column, a
 * full-width-minus-cards event feed, and 12px+ fonts everywhere.
 */
import { MAP_HEIGHT, MAP_WIDTH, TILE_SIZE } from "@contracts/types";

export const HUD_W = MAP_WIDTH * TILE_SIZE; // 768
export const HUD_H = MAP_HEIGHT * TILE_SIZE; // 576

// -- contract rule 14: every HUD font ≥ 12 logical px ------------------------
export const FONT_SIZE_SMALL = 12;
export const FONT_SIZE_BASE = 13;
export const FONT_SIZE_TITLE = 14;
/** Family used across the HUD (monospace keeps clip math predictable). */
export const HUD_FONT = "ui-monospace, Menlo, Consolas, monospace";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

// -- top bar (row 1: controls + clock; row 2: kill-switch + state badges) ------
export const TOPBAR_H = 24;
export const BADGE_ROW_Y = TOPBAR_H;
export const BADGE_ROW_H = 20;
/** Total height of the two-row top chrome. */
export const HUD_TOP_H = TOPBAR_H + BADGE_ROW_H; // 44

// -- agent card column (right) -------------------------------------------------
export const CARD_W = 236;
export const CARD_X = HUD_W - CARD_W - 4; // 528
export const CARD_TOP = HUD_TOP_H + 4; // 48
export const CARD_GAP = 4;
/** Full card: swatch+name, gold/energy, plan, goal, 2-line thought, action,
 *  3 relationship rows, meta. */
export const CARD_H_NORMAL = 168;
/** Compact (4+ agents): drops thought + 2 relationship rows. */
export const CARD_H_COMPACT = 108;

/** Card height for an agent count — always fits the column on screen. */
export function cardHeight(count: number): number {
  if (count <= 3) return CARD_H_NORMAL;
  const fit = Math.floor((HUD_H - CARD_TOP - 4) / count) - CARD_GAP;
  return Math.min(CARD_H_COMPACT, fit);
}

export function cardRect(index: number, count: number): Rect {
  const h = cardHeight(count);
  return { x: CARD_X, y: CARD_TOP + index * (h + CARD_GAP), w: CARD_W, h };
}

/** Index of the card under (px,py), or null. Drives the scene-level click
 *  hit-test (fixes the v1 dead-first-click on freshly created card objects). */
export function cardIndexAt(px: number, py: number, count: number): number | null {
  for (let i = 0; i < count; i++) {
    if (pointInRect(px, py, cardRect(i, count))) return i;
  }
  return null;
}

// -- event feed (bottom-left; never under the card column) ---------------------
export const LOG_LINES = 10;
export const LOG_LINE_H = 14;
export const LOG_X = 4;
export const LOG_W = CARD_X - 8; // 520
export const LOG_H = LOG_LINES * LOG_LINE_H + 10; // 150
export const LOG_Y = HUD_H - LOG_H - 4; // 422
export const LOG_PAD_X = 6;
export const LOG_PAD_Y = 5;
/** ~7.3px/char at 12px monospace inside LOG_W − padding. */
export const LOG_MAX_CHARS = 68;

export function feedLineRect(i: number): Rect {
  return {
    x: LOG_X,
    y: LOG_Y + LOG_PAD_Y + i * LOG_LINE_H,
    w: LOG_W,
    h: LOG_LINE_H,
  };
}

export function feedLineIndexAt(px: number, py: number): number | null {
  for (let i = 0; i < LOG_LINES; i++) {
    if (pointInRect(px, py, feedLineRect(i))) return i;
  }
  return null;
}

// -- decision trace panel (left of the cards, above the feed) ------------------
export const PANEL_X = 4;
export const PANEL_Y = CARD_TOP; // 30
export const PANEL_W = CARD_X - 8; // 520
export const PANEL_H = LOG_Y - PANEL_Y - 4; // 388
/** Entry stack starts below title + persona subtitle. */
export const PANEL_HEADER_H = 36;
export const PANEL_VISIBLE_TRACE = 5;

export const PANEL_RECT: Rect = { x: PANEL_X, y: PANEL_Y, w: PANEL_W, h: PANEL_H };
export const PANEL_CLOSE_RECT: Rect = {
  x: PANEL_X + PANEL_W - 22,
  y: PANEL_Y,
  w: 22,
  h: 20,
};
