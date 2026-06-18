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
// Readability polish: the whole scale is lifted ~15-25% over the old
// 12/13/14 so dense cards and the feed read comfortably, while the smallest
// size stays ≥ 12 (contract floor). Row pitch (line spacing) is widened at the
// call sites that stack text (cards, feed, transcript) to match.
export const FONT_SIZE_SMALL = 13;
export const FONT_SIZE_BASE = 15;
export const FONT_SIZE_TITLE = 17;
/**
 * Body family — a clean system sans for prose (names, labels, status) reads
 * noticeably softer than a terminal mono. Numerals/code rows (gold, energy,
 * meta, decision-trace JSON) keep MONO_FONT so columns stay aligned and the
 * clip-char math (chars × px) remains predictable.
 */
export const HUD_FONT = "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
/** Monospace family for numeric/code rows where column alignment matters. */
export const MONO_FONT = "ui-monospace, Menlo, Consolas, monospace";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/**
 * Smallest axis-aligned rect covering both inputs. Used to publish a single
 * click-through guard rect when the party strip AND the transcript panel are
 * both visible in the left band. Integer pixels (inputs are already integers).
 */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

// -- fixed design metrics (independent of viewport size) ---------------------
// Readability polish: chrome rows and cards gained vertical room to match the
// larger type scale (above) and a touch more line spacing.
export const TOPBAR_H = 30;
export const BADGE_ROW_H = 26;
/** Total height of the two-row top chrome. */
export const HUD_TOP_H = TOPBAR_H + BADGE_ROW_H; // 56

export const CARD_W = 250;
export const CARD_GAP = 8;
/** Full card (≤3 agents): swatch+name, gold/energy, plan, goal, 2-line thought,
 *  action, 3 relationship rows, meta. Taller than v1 to fit the bigger type +
 *  more line spacing; ≤3 agents leaves ample vertical room. */
export const CARD_H_NORMAL = 200;
/** Compact (4+ agents): drops thought + 2 relationship rows. Kept lean so the
 *  cardHeight() clamp can grant near-full height even with 6-7 stacked cards;
 *  rows stay 13px (≥ contract floor) at a tight pitch in this dense case. */
export const CARD_H_COMPACT = 116;

export const LOG_LINES = 10;
export const LOG_LINE_H = 17;
export const LOG_PAD_X = 8;
export const LOG_PAD_Y = 7;
export const LOG_H = LOG_LINES * LOG_LINE_H + 12; // fixed height
/** ~8.0px/char at 13px monospace inside LOG_W − padding. */
export const LOG_MAX_CHARS = 68;

export const PANEL_HEADER_H = 42;
export const PANEL_VISIBLE_TRACE = 5;

/** Gutter reserved below the top chrome for the "AGENTS" / left-band section
 *  headers, so labels sit clearly above the first card / panel instead of
 *  crammed against the badge-row edge. */
export const CARD_HEADER_H = 18;

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
  /** Baseline Y for the section-header labels ("AGENTS", left-band) drawn in
   *  the gutter between the top chrome and the first card / panel. */
  cardHeaderY: number;
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
  /** v3 — live party showcase strip, docked top-left over the trace-panel band */
  partyX: number;
  partyY: number;
  partyW: number;
  partyH: number;
  partyRect: Rect;
  /** v3 (Wave 2) — conversation transcript panel, docked below the party strip
   *  and above the feed, in the left band */
  transcriptX: number;
  transcriptY: number;
  transcriptW: number;
  transcriptH: number;
  transcriptRect: Rect;
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
  const cardTop = HUD_TOP_H + 4 + CARD_HEADER_H;
  const logH = LOG_H;
  const logY = h - logH - 4;
  const logX = 4;
  const logW = Math.max(120, cardX - 8);
  // Truncation must track the live feed width, not the old 768px design width:
  // ~8.0px/char for the 13px monospace feed font (matches the design's 68 chars
  // over its ~508px usable width). Without this the feed clips early on wide
  // screens and leaves a large empty gutter.
  const logMaxChars = Math.max(24, Math.floor((logW - 2 * LOG_PAD_X) / 8.0));
  const panelX = 4;
  const panelY = cardTop;
  const panelW = Math.max(120, cardX - 8);
  const panelH = Math.max(60, logY - panelY - 4);
  const panelRect: Rect = { x: panelX, y: panelY, w: panelW, h: panelH };

  // v3 — live party showcase: a slim strip (≤96px) overlaying the top of the
  // trace-panel band (top-left). Reuses panelX/panelY/panelW; height is clamped
  // so it never grows past the band. The trace panel is transient (opened on
  // card click), so the strip overlays — never displaces — existing chrome.
  const partyX = panelX;
  const partyY = panelY;
  const partyW = panelW;
  const partyH = Math.min(108, Math.max(68, panelH));
  const partyRect: Rect = { x: partyX, y: partyY, w: partyW, h: partyH };

  // v3 (Wave 2) — conversation transcript panel: docked BELOW the party strip
  // and ABOVE the feed, reusing the left band's x/width. Height is clamped to the
  // gap actually left above the feed (cap 120px). No min-floor: a 60px floor
  // would push the bottom past logY and overlap the feed at viewport heights
  // below ~362px. At the design size this is the full 120px. The trace panel is
  // transient and overlays this band when open.
  const transcriptX = panelX;
  const transcriptY = partyY + partyH + 4;
  const transcriptW = panelW;
  const transcriptH = Math.max(0, Math.min(120, logY - transcriptY - 4));
  const transcriptRect: Rect = {
    x: transcriptX,
    y: transcriptY,
    w: transcriptW,
    h: transcriptH,
  };

  const cardHeight = (count: number): number => {
    // Height that lets `count` cards (+ gaps) stack inside the column band.
    const fit = Math.floor((h - cardTop - 4) / count) - CARD_GAP;
    // ≤3 agents use the roomy NORMAL card, but never taller than the band
    // allows (short frames like the 768×576 design size must still fit 3).
    const cap = count <= 3 ? CARD_H_NORMAL : CARD_H_COMPACT;
    return Math.max(40, Math.min(cap, fit));
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
    cardHeaderY: HUD_TOP_H + 4,
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
    partyX,
    partyY,
    partyW,
    partyH,
    partyRect,
    transcriptX,
    transcriptY,
    transcriptW,
    transcriptH,
    transcriptRect,
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
export const HUD_W = 768; // v1 design frame: 24 tiles × 32px (frozen)
export const HUD_H = 576; // v1 design frame: 18 tiles × 32px (frozen)

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
