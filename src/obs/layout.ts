/**
 * HUD layout math — pure (no Phaser), so contract rule 14 ("minimum effective
 * 12px at zoom 1, integer pixel positions") is unit-testable headlessly.
 *
 * v4 — RESTRUCTURE for readability. The HUD now docks to the live viewport in
 * three regions docked to the window edges:
 *
 *   ┌──────────────────────── SpaceCon command bar (full width) ─────────────┐
 *   │ wordmark · transport · speed · mock/live    →    clock · telemetry chips│
 *   ├──────────────────────────────────────────────┬─────────────────────────┤
 *   │                                              │  CONVERSATION (top)      │
 *   │                MAP (center-left, wide)        │  ─ right panel ─         │
 *   │                                              │  EVENTS feed (bottom)    │
 *   ├──────────────────────────────────────────────┴─────────────────────────┤
 *   │ AGENTS — horizontal strip of compact cards (wraps / scrolls)            │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *
 * The CONVERSATION transcript + EVENTS feed live in a fixed-width RIGHT panel
 * (full height under the top chrome). The AGENTS cards moved to a HORIZONTAL
 * BOTTOM STRIP (left-to-right, wrapping to a 2nd row). The map fills the wider
 * center-left area between the top chrome, the right panel, and the bottom
 * strip. The party/governance showcase strip and the decision-trace panel
 * overlay the right panel's conversation region (they're transient).
 *
 * `computeHud(viewW, viewH)` returns every rect docked to the window edges and
 * is recomputed on every resize. The legacy 768x576 constants/functions below
 * are retained (as thin wrappers over computeHud at the design size) so the
 * pure layout unit tests keep a stable design-size reference.
 */
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from "./theme";

// -- contract rule 14: every HUD font ≥ 12 logical px ------------------------
// Readability polish: the whole scale is lifted ~15-25% over the old
// 12/13/14 so dense cards and the feed read comfortably, while the smallest
// size stays ≥ 12 (contract floor). Row pitch (line spacing) is widened at the
// call sites that stack text (cards, feed, transcript) to match.
export const FONT_SIZE_SMALL = 13;
export const FONT_SIZE_BASE = 15;
export const FONT_SIZE_TITLE = 17;

/**
 * HUD font families — SpaceCon design-token stacks (single source: theme.ts).
 *
 *  - HUD_FONT (display, Space Grotesk) — names, numbers, titles, section headers.
 *  - HUD_FONT_BODY (IBM Plex Sans) — prose: goals, thought/quote, persona, chat.
 *  - MONO_FONT (IBM Plex Mono) — numeric/code rows, labels, telemetry, badges
 *    where column alignment matters and the clip-char math (chars × px) holds.
 */
export const HUD_FONT = FONT_DISPLAY;
/** Body family for prose strings (goal, thought/quote, persona, transcript). */
export const HUD_FONT_BODY = FONT_BODY;
/** Monospace family for numeric/code rows where column alignment matters. */
export const MONO_FONT = FONT_MONO;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// -- KPI value formatters (pure — testable headlessly) -----------------------
/**
 * Economy KPI value: a non-negative integer gold total with thousands
 * separators and a trailing `g` (e.g. 2400 → "2,400g", 0 → "0g"). The caller
 * renders the `g` faint (ink400). Non-finite / negative inputs clamp to "0g"
 * (honest empty — never a fabricated number).
 */
export function formatEconomy(gold: number): string {
  const n = Number.isFinite(gold) ? Math.max(0, Math.round(gold)) : 0;
  return `${n.toLocaleString("en-US")}g`;
}

/**
 * Average-energy KPI value: a mean 0..100 rounded to a whole percent
 * (e.g. 71.4 → "71%"). Non-finite input (no agents) clamps to "0%".
 */
export function formatPercent(mean: number): string {
  const n = Number.isFinite(mean) ? Math.max(0, Math.round(mean)) : 0;
  return `${n}%`;
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/**
 * Smallest axis-aligned rect covering both inputs. Used to publish a single
 * click-through guard rect when the showcase strip AND the transcript panel are
 * both visible in the right panel. Integer pixels (inputs are already integers).
 */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

// -- fixed design metrics (independent of viewport size) ---------------------
// B-2: the old two-row top chrome (TOPBAR_H + BADGE_ROW_H) collapses into a
// SINGLE SpaceCon command bar (design README §1). CMDBAR_H is the bar height;
// it is the single top-region anchor every other region (map / right panel /
// strip) and isPointOverHud key off via `topH`.
export const CMDBAR_H = 46;
/** Single command-bar height. The badge row is gone — the kill-switch + paused
 *  + budget indicators fold into the bar. Retained name = CMDBAR_H. */
export const TOPBAR_H = CMDBAR_H;
/** The badge row collapsed into the command bar — zero height, anchored at the
 *  bar's bottom edge (kept so readers of these fields still resolve). */
export const BADGE_ROW_H = 0;
/** Total height of the top chrome — now a single command bar. */
export const HUD_TOP_H = CMDBAR_H;

// -- KPI band (B-3, design README §2) ----------------------------------------
// A horizontal row of FIVE equal KPI tiles in the LEFT column, directly below
// the command bar and ABOVE the map. The map shifts down by KPI_BAND_H. The
// right panel + bottom strip are UNCHANGED (the band is left-column only; the
// right rail still starts at topH). Integer; the band is tall enough for a
// 10.5px mono label over a 24px display value plus ~12px top/bottom padding.
export const KPI_BAND_H = 60;
/** Number of KPI tiles in the band (design README §2: five run-level numbers). */
export const KPI_TILE_COUNT = 5;
/** Gap between KPI tiles (design README §2: flex row, gap ~12px). */
export const KPI_TILE_GAP = 12;
/** Outer inset of the KPI band from the left/right edges of the left column. */
export const KPI_BAND_PAD = 4;
/** Value font for the KPI tiles — a NEW larger display size (≥12, rule 14). */
export const FONT_SIZE_KPI_VALUE = 24;
/** Mono label font for the KPI tiles (≥12, rule 14). */
export const FONT_SIZE_KPI_LABEL = 12;

// -- RIGHT panel (conversation + events) ------------------------------------
/** Preferred width of the fixed right-side panel that holds the conversation
 *  transcript (top) and the events feed (bottom). Comfortably readable. */
export const RIGHT_PANEL_W = 360;
/** Min width the right panel may shrink to on narrow viewports. */
const RIGHT_PANEL_MIN_W = 220;
/** Gutter inside the right panel (and between its conversation / events halves). */
export const RIGHT_PAD = 8;
/** Header band ("CONVERSATION" / "EVENTS") height within the right panel. */
export const RIGHT_HEADER_H = 22;

// -- BOTTOM strip (horizontal agent cards) ----------------------------------
/** Height of the bottom agent strip. Tall enough for one compact card row plus
 *  its section label; the strip scrolls/wraps horizontally for 26 agents. */
export const STRIP_H = 200;
/** Header gutter above the strip cards ("AGENTS · N"). */
export const STRIP_HEADER_H = 18;
/** Full bottom-strip card — laid out LEFT→RIGHT in a single row; the strip
 *  scrolls horizontally so every agent's card is reachable (UIScene cardScroll).
 *  Wide enough for the full intrinsic-drive needs row on its own line. */
export const CARD_W = 246;
export const CARD_H = STRIP_H - STRIP_HEADER_H - 8; // card body height inside strip
export const CARD_GAP = 8;

/** Minimum width the map stays visible at (the right panel never eats it all). */
const MIN_WORLD_W = 360;
/** Minimum height the map stays visible at (strip never eats it all). */
const MIN_WORLD_H = 200;

// -- event feed (now docked in the right panel's bottom half) ---------------
export const LOG_LINES = 10;
export const LOG_LINE_H = 17;
export const LOG_PAD_X = 8;
export const LOG_PAD_Y = 7;

export const PANEL_HEADER_H = 42;
export const PANEL_VISIBLE_TRACE = 5;

/** Gutter reserved below the top chrome for section headers. */
export const CARD_HEADER_H = 18;

/**
 * Responsive HUD geometry docked to a live viewport. All rects are integer
 * pixels. The conversation + events feed dock to a fixed-width RIGHT panel; the
 * agent cards lay out horizontally along the BOTTOM strip; the map fills the
 * wider center-left area between them and the top chrome.
 */
export interface HudLayout {
  w: number;
  h: number;
  topbarH: number;
  badgeRowY: number;
  badgeRowH: number;
  topH: number;
  statusX: number;

  // -- right panel (conversation top, events bottom) ------------------------
  /** Left edge of the fixed-width right panel (also the map's right boundary). */
  rightX: number;
  rightW: number;
  rightTop: number;
  rightRect: Rect;

  // -- KPI band (left column, below the command bar, above the map) ---------
  /** Top edge of the KPI band (== topH). */
  kpiY: number;
  /** Height of the KPI band (== KPI_BAND_H). */
  kpiH: number;
  /** Left-column width the band spans (== rightX / the map's width). */
  kpiW: number;
  /** Full KPI band rect (x:0, y:topH, w:kpiW, h:KPI_BAND_H). */
  kpiBandRect: Rect;
  /** Per-tile rect (i: 0..4) — five equal tiles with KPI_TILE_GAP between. */
  kpiTileRect(i: number): Rect;

  // -- map viewport (center-left) -------------------------------------------
  mapX: number;
  mapY: number;
  mapW: number;
  mapH: number;
  mapRect: Rect;

  // -- bottom agent strip ----------------------------------------------------
  /** Top edge of the bottom agent strip. */
  stripY: number;
  stripH: number;
  stripHeaderY: number;
  cardW: number;
  /** Left edge of the right panel — retained name for isPointOverHud + headers. */
  cardX: number;
  /** Top edge of the bottom-strip cards (below the strip's section header). */
  cardTop: number;
  cardHeaderY: number;
  cardGap: number;

  // -- events feed (right panel, bottom half) -------------------------------
  logX: number;
  logY: number;
  logW: number;
  logH: number;
  logLines: number;
  logLineH: number;
  logPadX: number;
  logPadY: number;
  logMaxChars: number;

  // -- trace panel (overlays the right-panel conversation region) -----------
  panelX: number;
  panelY: number;
  panelW: number;
  panelH: number;
  panelRect: Rect;
  panelCloseRect: Rect;
  panelHeaderH: number;
  panelVisibleTrace: number;

  // -- party / governance showcase strip (overlays conversation region) -----
  partyX: number;
  partyY: number;
  partyW: number;
  partyH: number;
  partyRect: Rect;

  // -- conversation transcript (right panel, top half) ----------------------
  transcriptX: number;
  transcriptY: number;
  transcriptW: number;
  transcriptH: number;
  transcriptRect: Rect;

  cardHeight(count: number): number;
  cardRect(index: number, count: number): Rect;
  /** How many full cards fit in the strip row (the horizontal scroll page). */
  cardsPerPage(): number;
  feedLineRect(i: number): Rect;
  cardIndexAt(px: number, py: number, count: number): number | null;
  feedLineIndexAt(px: number, py: number): number | null;
}

export function computeHud(viewW: number, viewH: number): HudLayout {
  const w = Math.max(1, Math.round(viewW));
  const h = Math.max(1, Math.round(viewH));

  // -- RIGHT panel: fixed width, shrinks only if the map would go below its
  //    minimum. Spans full height under the top chrome.
  const rightW = Math.min(
    Math.max(RIGHT_PANEL_MIN_W, w - MIN_WORLD_W),
    RIGHT_PANEL_W,
  );
  const rightX = w - rightW;
  const rightTop = HUD_TOP_H;
  // Bottom strip: a horizontal band along the bottom edge. Shrinks only if the
  // map would go below its minimum height.
  const stripH = Math.min(
    STRIP_H,
    Math.max(64, h - HUD_TOP_H - MIN_WORLD_H),
  );
  const stripY = h - stripH;
  const rightH = Math.max(80, h - rightTop);
  const rightRect: Rect = { x: rightX, y: rightTop, w: rightW, h: rightH };

  // -- KPI band: a row of five equal tiles in the LEFT column, directly below
  //    the command bar and above the map. Spans the map's width (x:0..rightX).
  const kpiY = HUD_TOP_H;
  const kpiH = KPI_BAND_H;
  const kpiW = rightX;
  const kpiBandRect: Rect = { x: 0, y: kpiY, w: kpiW, h: kpiH };
  // Five equal tiles inside the band (after the outer pad), separated by
  // KPI_TILE_GAP. Integer pixels — widths/offsets are floored, with the tile's
  // own width derived from its start so rounding never overflows the band.
  const kpiInnerX = KPI_BAND_PAD;
  const kpiInnerW = Math.max(
    KPI_TILE_COUNT, // never collapse below 1px/tile
    kpiW - 2 * KPI_BAND_PAD,
  );
  const kpiTileTop = kpiY + KPI_BAND_PAD;
  const kpiTileH = Math.max(1, kpiH - 2 * KPI_BAND_PAD);
  const kpiSpan = kpiInnerW - (KPI_TILE_COUNT - 1) * KPI_TILE_GAP;
  const kpiTileRect = (i: number): Rect => {
    const idx = Math.max(0, Math.min(KPI_TILE_COUNT - 1, i));
    const x0 = kpiInnerX + Math.floor((kpiSpan * idx) / KPI_TILE_COUNT) + idx * KPI_TILE_GAP;
    const x1 = kpiInnerX + Math.floor((kpiSpan * (idx + 1)) / KPI_TILE_COUNT) + idx * KPI_TILE_GAP;
    return { x: x0, y: kpiTileTop, w: Math.max(1, x1 - x0), h: kpiTileH };
  };

  // -- MAP viewport: center-left, between the KPI band / right panel / strip.
  //    The map shifts DOWN by KPI_BAND_H (B-3): its top is topH + KPI_BAND_H.
  const mapX = 0;
  const mapY = HUD_TOP_H + KPI_BAND_H;
  const mapW = Math.max(MIN_WORLD_W, rightX);
  const mapH = Math.max(MIN_WORLD_H, stripY - mapY);
  const mapRect: Rect = { x: mapX, y: mapY, w: mapW, h: mapH };

  // -- Right panel split: conversation (top) over events feed (bottom). The
  //    events feed gets a fixed slot sized to its LOG_LINES; the conversation
  //    transcript takes the remaining upper space.
  const panelInnerX = rightX + RIGHT_PAD;
  const panelInnerW = Math.max(120, rightW - 2 * RIGHT_PAD);

  // Events feed: docked to the BOTTOM of the right panel.
  const logLineBlock = LOG_LINES * LOG_LINE_H + 2 * LOG_PAD_Y;
  const eventsH = logLineBlock + 4;
  const eventsTop = h - eventsH - 6;
  const logX = panelInnerX;
  const logW = panelInnerW;
  const logH = eventsH;
  const logY = eventsTop;
  // ~8.0px/char for the 13px monospace feed font.
  const logMaxChars = Math.max(24, Math.floor((logW - 2 * LOG_PAD_X) / 8.0));

  // Conversation region top: just below the persistent "CONVERSATION" header.
  const convTop = rightTop + RIGHT_HEADER_H + 2;
  // Bottom of the conversation region: just above the events feed's header.
  const convBottom = logY - RIGHT_HEADER_H - 4;

  // Party / governance showcase strip: a slim banner pinned to the TOP of the
  // conversation region. Transient — when shown it STACKS above the transcript
  // (does not overlap it). Fixed slim height.
  const partyX = panelInnerX;
  const partyY = convTop;
  const partyW = panelInnerW;
  // Slim banner, clamped so it never eats more than ~40% of the conversation
  // region (leaves the transcript its space even on short viewports).
  const partyH = Math.max(68, Math.min(100, Math.floor((convBottom - convTop) * 0.4)));
  const partyRect: Rect = { x: partyX, y: partyY, w: partyW, h: partyH };

  // Conversation transcript: BELOW the showcase strip band, down to just above
  // the events feed header. (The strip overlays its own band only; the
  // transcript starts beneath it so the two never collide.)
  const transcriptX = panelInnerX;
  const transcriptY = partyY + partyH + 4;
  const transcriptW = panelInnerW;
  const transcriptH = Math.max(60, convBottom - transcriptY);
  const transcriptRect: Rect = {
    x: transcriptX,
    y: transcriptY,
    w: transcriptW,
    h: transcriptH,
  };

  // Trace panel: overlays the FULL conversation region (from just below the
  // persistent header down to just above the events feed). Transient — opened
  // on card/feed click; covers both the showcase strip and the transcript.
  const panelX = panelInnerX;
  const panelY = convTop;
  const panelW = panelInnerW;
  const panelH = Math.max(60, convBottom - panelY);
  const panelRect: Rect = { x: panelX, y: panelY, w: panelW, h: panelH };

  // -- BOTTOM strip cards: full-size cards laid out LEFT→RIGHT in a single row
  //    from x=4. The strip SCROLLS horizontally (UIScene windows the agent list
  //    by cardScroll), so `index`/`count` here are SLOT positions in the current
  //    visible window — every agent's card is reachable by scrolling. Cards whose
  //    slot runs past the right panel are not drawn (they're scrolled to).
  const cardTop = stripY + STRIP_HEADER_H;
  const cardW = CARD_W;
  const cardHeight = (_count: number): number => {
    // Single full-height row of cards inside the strip body.
    const body = stripH - STRIP_HEADER_H - 6;
    return Math.max(40, Math.min(CARD_H, body));
  };
  const cardRect = (index: number, count: number): Rect => {
    const ch = cardHeight(count);
    const x = 4 + index * (cardW + CARD_GAP);
    return { x, y: cardTop, w: cardW, h: ch };
  };
  const feedLineRect = (i: number): Rect => ({
    x: logX,
    y: logY + LOG_PAD_Y + i * LOG_LINE_H,
    w: logW,
    h: LOG_LINE_H,
  });
  /** How many full cards fit in one row before the right panel (the scroll
   *  window size). At least 1 so a narrow viewport still shows a card. */
  const cardsPerPage = (): number => {
    let n = 0;
    while (4 + (n + 1) * (cardW + CARD_GAP) - CARD_GAP <= rightX) n++;
    return Math.max(1, n);
  };
  const cardIndexAt = (px: number, py: number, count: number): number | null => {
    for (let i = 0; i < count; i++) {
      const r = cardRect(i, count);
      // Only slots that fit left of the right panel are drawn + clickable.
      if (r.x + r.w > rightX) break;
      if (pointInRect(px, py, r)) return i;
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
    topbarH: CMDBAR_H,
    // Badge row collapsed into the command bar: zero height, anchored at the
    // bar's bottom edge. `topH` stays the single top-region anchor.
    badgeRowY: CMDBAR_H,
    badgeRowH: 0,
    topH: HUD_TOP_H,
    statusX: w - 6,
    rightX,
    rightW,
    rightTop,
    rightRect,
    kpiY,
    kpiH,
    kpiW,
    kpiBandRect,
    kpiTileRect,
    mapX,
    mapY,
    mapW,
    mapH,
    mapRect,
    stripY,
    stripH,
    stripHeaderY: stripY + 2,
    cardW,
    cardX: rightX,
    cardTop,
    cardHeaderY: stripY + 2,
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
    cardsPerPage,
    feedLineRect,
    cardIndexAt,
    feedLineIndexAt,
  };
}

/**
 * True when a screen point falls on opaque HUD chrome (top chrome, the
 * right-side conversation/events panel, or the bottom agent strip). WorldScene
 * uses this to suppress camera pan / click-to-follow when the spectator is
 * interacting with the HUD. The trace panel is handled separately (it's
 * transient) via the REG_HUD_PANEL registry rect.
 */
export function isPointOverHud(hud: HudLayout, px: number, py: number): boolean {
  if (py <= hud.topH) return true; // command bar, full width
  if (px >= hud.rightX) return true; // right-side conversation/events panel
  if (py >= hud.stripY) return true; // bottom agent strip
  // B-3: the KPI band is opaque chrome in the LEFT column directly below the
  // command bar (x < rightX, y in [topH, topH+KPI_BAND_H)). Guard it so world
  // clicks on the band don't fall through to the map beneath it.
  if (py < hud.mapY && px < hud.rightX) return true; // KPI band
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
// unit tests reference. The live HUD docks to the viewport (computeHud), so this
// design size is independent of the map dimensions.
export const HUD_W = 768; // v1 design frame: 24 tiles × 32px (frozen)
export const HUD_H = 576; // v1 design frame: 18 tiles × 32px (frozen)

const DESIGN = computeHud(HUD_W, HUD_H);

export const BADGE_ROW_Y = DESIGN.badgeRowY;
export const CARD_X = DESIGN.cardX;
export const CARD_TOP = DESIGN.cardTop;
export const LOG_X = DESIGN.logX;
export const LOG_W = DESIGN.logW;
export const LOG_Y = DESIGN.logY;
export const LOG_H = DESIGN.logH;
export const PANEL_X = DESIGN.panelX;
export const PANEL_Y = DESIGN.panelY;
export const PANEL_W = DESIGN.panelW;
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
