/**
 * HUD layout math — pure (no Phaser), so contract rule 14 ("minimum effective
 * 12px at zoom 1, integer pixel positions") is unit-testable headlessly.
 *
 * v3: the canvas is now fullscreen (Phaser.Scale.RESIZE — see src/main.ts), so
 * the HUD must DOCK to the live viewport instead of a fixed 768x576 frame.
 * `computeHud(viewW, viewH)` returns every rect docked to the window edges
 * (top chrome full-width; agent cards on the right edge; event feed bottom-left;
 * trace panel filling the left-middle). UIScene recomputes it on every resize.
 *
 * The legacy 768x576 constants/functions below are retained (as thin wrappers
 * over computeHud at the design size) so the pure layout unit tests keep
 * asserting the same geometry.
 */

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

// -- fixed design metrics (independent of viewport size) ---------------------
export const TOPBAR_H = 24;
export const BADGE_ROW_H = 20;
/** Total height of the two-row top chrome. */
export const HUD_TOP_H = TOPBAR_H + BADGE_ROW_H; // 44

export const CARD_W = 236;
export const CARD_GAP = 4;
/** Full card: swatch+name, gold/energy, plan, goal, 2-line thought, action,
 *  3 relationship rows, meta. */
export const CARD_H_NORMAL = 168;
/** Compact (4+ agents): drops thought + 2 relationship rows. */
export const CARD_H_COMPACT = 108;

export const LOG_LINES = 10;
export const LOG_LINE_H = 14;
export const LOG_PAD_X = 6;
export const LOG_PAD_Y = 5;
export const LOG_H = LOG_LINES * LOG_LINE_H + 10; // 150 — fixed height
/** ~7.3px/char at 12px monospace inside LOG_W − padding. */
export const LOG_MAX_CHARS = 68;

export const PANEL_HEADER_H = 36;
export const PANEL_VISIBLE_TRACE = 5;

/** Minimum width the world stays visible at (cards never eat the whole screen). */
const MIN_WORLD_W = 280;

/**
 * Responsive HUD geometry docked to a live viewport. All rects are integer
 * pixels. Cards dock to the right edge, the feed to the bottom-left, the trace
 * panel fills the left-middle band between the top chrome and the feed.
 */
export interface HudLayout {
  w: number;
  h: number;
  topbarH: number;
  badgeRowY: number;
  badgeRowH: number;
  topH: number;
  statusX: number;
  cardW: number;
  cardX: number;
  cardTop: number;
  cardGap: number;
  logX: number;
  logY: number;
  logW: number;
  logH: number;
  logLines: number;
  logLineH: number;
  logPadX: number;
  logPadY: number;
  logMaxChars: number;
  panelX: number;
  panelY: number;
  panelW: number;
  panelH: number;
  panelRect: Rect;
  panelCloseRect: Rect;
  panelHeaderH: number;
  panelVisibleTrace: number;
  cardHeight(count: number): number;
  cardRect(index: number, count: number): Rect;
  feedLineRect(i: number): Rect;
  cardIndexAt(px: number, py: number, count: number): number | null;
  feedLineIndexAt(px: number, py: number): number | null;
}

export function computeHud(viewW: number, viewH: number): HudLayout {
  const w = Math.max(1, Math.round(viewW));
  const h = Math.max(1, Math.round(viewH));
  // Cards shrink only if the window is too narrow to keep the world visible.
  const cardW = Math.min(CARD_W, Math.max(120, w - MIN_WORLD_W));
  const cardX = w - cardW - 4;
  const cardTop = HUD_TOP_H + 4;
  const logH = LOG_H;
  const logY = h - logH - 4;
  const logX = 4;
  const logW = Math.max(120, cardX - 8);
  // Truncation must track the live feed width, not the old 768px design width:
  // ~7.5px/char for the 12px monospace feed font (matches the design's 68 chars
  // over its ~508px usable width). Without this the feed clips early on wide
  // screens and leaves a large empty gutter.
  const logMaxChars = Math.max(24, Math.floor((logW - 2 * LOG_PAD_X) / 7.5));
  const panelX = 4;
  const panelY = cardTop;
  const panelW = Math.max(120, cardX - 8);
  const panelH = Math.max(60, logY - panelY - 4);
  const panelRect: Rect = { x: panelX, y: panelY, w: panelW, h: panelH };

  const cardHeight = (count: number): number => {
    if (count <= 3) return CARD_H_NORMAL;
    const fit = Math.floor((h - cardTop - 4) / count) - CARD_GAP;
    return Math.max(40, Math.min(CARD_H_COMPACT, fit));
  };
  const cardRect = (index: number, count: number): Rect => {
    const ch = cardHeight(count);
    return { x: cardX, y: cardTop + index * (ch + CARD_GAP), w: cardW, h: ch };
  };
  const feedLineRect = (i: number): Rect => ({
    x: logX,
    y: logY + LOG_PAD_Y + i * LOG_LINE_H,
    w: logW,
    h: LOG_LINE_H,
  });
  const cardIndexAt = (px: number, py: number, count: number): number | null => {
    for (let i = 0; i < count; i++) {
      if (pointInRect(px, py, cardRect(i, count))) return i;
    }
    return null;
  };
  const feedLineIndexAt = (px: number, py: number): number | null => {
    for (let i = 0; i < LOG_LINES; i++) {
      if (pointInRect(px, py, feedLineRect(i))) return i;
    }
    return null;
  };

  return {
    w,
    h,
    topbarH: TOPBAR_H,
    badgeRowY: TOPBAR_H,
    badgeRowH: BADGE_ROW_H,
    topH: HUD_TOP_H,
    statusX: w - 6,
    cardW,
    cardX,
    cardTop,
    cardGap: CARD_GAP,
    logX,
    logY,
    logW,
    logH,
    logLines: LOG_LINES,
    logLineH: LOG_LINE_H,
    logPadX: LOG_PAD_X,
    logPadY: LOG_PAD_Y,
    logMaxChars,
    panelX,
    panelY,
    panelW,
    panelH,
    panelRect,
    panelCloseRect: { x: panelX + panelW - 22, y: panelY, w: 22, h: 20 },
    panelHeaderH: PANEL_HEADER_H,
    panelVisibleTrace: PANEL_VISIBLE_TRACE,
    cardHeight,
    cardRect,
    feedLineRect,
    cardIndexAt,
    feedLineIndexAt,
  };
}

/**
 * True when a screen point falls on opaque HUD chrome (top bar/badges, the
 * right-hand card column, or the bottom-left event feed). WorldScene uses this
 * to suppress camera pan / click-to-follow when the spectator is interacting
 * with the HUD. The trace panel is handled separately (it's transient) via the
 * REG_HUD_PANEL registry rect.
 */
export function isPointOverHud(hud: HudLayout, px: number, py: number): boolean {
  if (py <= hud.topH) return true; // top bar + badge row, full width
  if (px >= hud.cardX) return true; // right-hand card column
  if (pointInRect(px, py, { x: hud.logX, y: hud.logY, w: hud.logW, h: hud.logH })) {
    return true; // event feed
  }
  return false;
}

/** Registry key: UIScene publishes the open trace-panel rect (or null) here so
 *  WorldScene can ignore world clicks that land on it. */
export const REG_HUD = "hudPanelRect";

// ---------------------------------------------------------------------------
// Legacy 768x576 design-space exports (retained for the pure layout unit tests
// and any code still importing them). These mirror computeHud at design size.
// ---------------------------------------------------------------------------
// Legacy fixed design size (768×576) — the v1 logical frame the pure layout
// unit tests assert. The live HUD docks to the viewport (computeHud), so this
// design size is independent of the map dimensions.
export const HUD_W = 768;
export const HUD_H = 576;

const DESIGN = computeHud(HUD_W, HUD_H);

export const BADGE_ROW_Y = DESIGN.badgeRowY;
export const CARD_X = DESIGN.cardX; // 528
export const CARD_TOP = DESIGN.cardTop; // 48
export const LOG_X = DESIGN.logX;
export const LOG_W = DESIGN.logW; // 520
export const LOG_Y = DESIGN.logY; // 422
export const PANEL_X = DESIGN.panelX;
export const PANEL_Y = DESIGN.panelY;
export const PANEL_W = DESIGN.panelW; // 520
export const PANEL_H = DESIGN.panelH;
export const PANEL_RECT: Rect = DESIGN.panelRect;
export const PANEL_CLOSE_RECT: Rect = DESIGN.panelCloseRect;

export function cardHeight(count: number): number {
  return DESIGN.cardHeight(count);
}
export function cardRect(index: number, count: number): Rect {
  return DESIGN.cardRect(index, count);
}
export function cardIndexAt(px: number, py: number, count: number): number | null {
  return DESIGN.cardIndexAt(px, py, count);
}
export function feedLineRect(i: number): Rect {
  return DESIGN.feedLineRect(i);
}
export function feedLineIndexAt(px: number, py: number): number | null {
  return DESIGN.feedLineIndexAt(px, py);
}
