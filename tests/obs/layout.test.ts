/**
 * HUD layout math (contract rule 14): minimum effective 12px fonts at zoom 1,
 * integer pixel positions, and regions that never overlap each other.
 *
 * v4 — RESTRUCTURE: the conversation transcript + events feed dock to a
 * fixed-width RIGHT panel; the agent cards lay out horizontally along the
 * BOTTOM strip; the map fills the wider center-left area between them.
 *
 * B-2 — the two-row top chrome (top bar + badge row) collapses into a SINGLE
 * SpaceCon command bar of height CMDBAR_H. `topH === CMDBAR_H` is now the only
 * top-region anchor every other region (map / right panel / strip) and
 * isPointOverHud key off; the badge row is gone (BADGE_ROW_H === 0).
 * Pure module — no Phaser needed.
 */
import { describe, expect, it } from "vitest";
import {
  BADGE_ROW_H,
  BADGE_ROW_Y,
  CARD_GAP,
  CARD_TOP,
  CARD_W,
  CARD_X,
  CMDBAR_H,
  FONT_SIZE_BASE,
  FONT_SIZE_SMALL,
  FONT_SIZE_TITLE,
  HUD_H,
  HUD_TOP_H,
  HUD_W,
  KPI_BAND_H,
  KPI_TILE_COUNT,
  KPI_TILE_GAP,
  FONT_SIZE_KPI_LABEL,
  FONT_SIZE_KPI_VALUE,
  formatEconomy,
  formatPercent,
  LOG_H,
  LOG_LINES,
  LOG_LINE_H,
  LOG_W,
  LOG_X,
  LOG_Y,
  PANEL_H,
  PANEL_W,
  PANEL_X,
  PANEL_Y,
  TOPBAR_H,
  cardHeight,
  cardIndexAt,
  cardRect,
  computeHud,
  feedLineIndexAt,
  feedLineRect,
  isPointOverHud,
  pointInRect,
  unionRect,
} from "../../src/obs/layout";

// A realistic desktop viewport used for the live-region assertions.
const VW = 1440;
const VH = 900;

describe("contract rule 14 — readable text", () => {
  it("every HUD font size is ≥ 12px effective at zoom 1", () => {
    expect(FONT_SIZE_SMALL).toBeGreaterThanOrEqual(12);
    expect(FONT_SIZE_BASE).toBeGreaterThanOrEqual(12);
    expect(FONT_SIZE_TITLE).toBeGreaterThanOrEqual(12);
    // B-3: the KPI band's label + (larger) value fonts are also ≥ 12 (rule 14).
    expect(FONT_SIZE_KPI_LABEL).toBeGreaterThanOrEqual(12);
    expect(FONT_SIZE_KPI_VALUE).toBeGreaterThanOrEqual(12);
  });

  it("feed line height fits the smallest font without clipping", () => {
    expect(LOG_LINE_H).toBeGreaterThanOrEqual(FONT_SIZE_SMALL);
  });

  it("all layout constants are integers (integer pixel positions)", () => {
    const values = [
      HUD_W, HUD_H, CMDBAR_H, TOPBAR_H, BADGE_ROW_H, BADGE_ROW_Y, HUD_TOP_H,
      KPI_BAND_H, KPI_TILE_COUNT, KPI_TILE_GAP,
      CARD_X, CARD_W, CARD_TOP, CARD_GAP,
      LOG_X, LOG_Y, LOG_W, LOG_H, LOG_LINE_H,
      PANEL_X, PANEL_Y, PANEL_W, PANEL_H,
    ];
    for (const v of values) expect(Number.isInteger(v)).toBe(true);
  });

  it("CARD_W is the SpaceCon card width (design §4: fixed 248px)", () => {
    // B-5: the card width is pinned to the design's 248px. Exact assertion so a
    // later drift away from the design constant fails loudly.
    expect(CARD_W).toBe(248);
  });

  it("card rects land on integer pixels for any sane agent count", () => {
    const hud = computeHud(VW, VH);
    for (const count of [1, 3, 6, 12, 26]) {
      for (let i = 0; i < count; i++) {
        const r = hud.cardRect(i, count);
        expect(Number.isInteger(r.x)).toBe(true);
        expect(Number.isInteger(r.y)).toBe(true);
        expect(Number.isInteger(r.h)).toBe(true);
      }
    }
  });
});

describe("B-2 — single SpaceCon command bar (top region)", () => {
  it("the top region is ONE command bar of height CMDBAR_H", () => {
    // topH — the single anchor every region keys off — equals the command-bar
    // height. There is no second (badge) row: BADGE_ROW_H is zero.
    expect(HUD_TOP_H).toBe(CMDBAR_H);
    expect(TOPBAR_H).toBe(CMDBAR_H);
    expect(BADGE_ROW_H).toBe(0);
    const hud = computeHud(VW, VH);
    expect(hud.topH).toBe(CMDBAR_H);
    expect(hud.topbarH).toBe(CMDBAR_H);
    expect(hud.badgeRowH).toBe(0);
    // the (collapsed) badge row anchors at the bar's bottom edge
    expect(hud.badgeRowY).toBe(CMDBAR_H);
  });

  it("CMDBAR_H is an integer in the design band (44–48px)", () => {
    expect(Number.isInteger(CMDBAR_H)).toBe(true);
    expect(CMDBAR_H).toBeGreaterThanOrEqual(44);
    expect(CMDBAR_H).toBeLessThanOrEqual(48);
  });

  it("the command bar spans the full viewport width", () => {
    const hud = computeHud(VW, VH);
    // the bar occupies x∈[0,w); the map / right panel / strip all dock BELOW it
    expect(hud.w).toBe(VW);
    expect(hud.mapX).toBe(0);
    expect(hud.rightTop).toBe(CMDBAR_H);
  });

  it("the map top docks at topH + KPI_BAND_H (B-3: map shifts below the KPI band)", () => {
    const hud = computeHud(VW, VH);
    // B-3 structural change: the KPI band sits between the command bar and the
    // map, so the map now starts KPI_BAND_H below topH (not at topH).
    expect(hud.mapY).toBe(hud.topH + KPI_BAND_H);
    expect(hud.mapY).toBe(CMDBAR_H + KPI_BAND_H);
    expect(hud.mapRect.y).toBe(CMDBAR_H + KPI_BAND_H);
    // the map no longer starts at topH — the band occupies that row now
    expect(hud.mapY).toBeGreaterThan(hud.topH);
  });

  it("isPointOverHud treats the whole command bar as HUD chrome", () => {
    const hud = computeHud(VW, VH);
    // anywhere inside the bar (top edge, mid-height, bottom edge) is HUD
    expect(isPointOverHud(hud, 200, 0)).toBe(true);
    expect(isPointOverHud(hud, 200, Math.floor(CMDBAR_H / 2))).toBe(true);
    expect(isPointOverHud(hud, 200, CMDBAR_H)).toBe(true);
    // B-3: one pixel below the bar now lands on the KPI band — still HUD chrome
    expect(isPointOverHud(hud, Math.round(hud.mapRect.x + hud.mapRect.w / 2), CMDBAR_H + 1)).toBe(true);
    // the open map proper (below the band) is NOT HUD
    expect(isPointOverHud(hud, Math.round(hud.mapRect.x + hud.mapRect.w / 2), hud.mapY + 1)).toBe(false);
  });
});

describe("B-3 — KPI band (left column, below the command bar, above the map)", () => {
  it("KPI_BAND_H is an integer in the design band (58–64px)", () => {
    expect(Number.isInteger(KPI_BAND_H)).toBe(true);
    expect(KPI_BAND_H).toBeGreaterThanOrEqual(58);
    expect(KPI_BAND_H).toBeLessThanOrEqual(64);
  });

  it("the band sits directly below the command bar (y === topH) at full band height", () => {
    const hud = computeHud(VW, VH);
    expect(hud.kpiBandRect.y).toBe(hud.topH);
    expect(hud.kpiY).toBe(hud.topH);
    expect(hud.kpiBandRect.h).toBe(KPI_BAND_H);
    expect(hud.kpiH).toBe(KPI_BAND_H);
    // the band ends exactly where the map begins (no gap, no overlap)
    expect(hud.kpiBandRect.y + hud.kpiBandRect.h).toBe(hud.mapY);
  });

  it("the band spans the LEFT column (x:0 .. rightX), left of the right panel", () => {
    const hud = computeHud(VW, VH);
    expect(hud.kpiBandRect.x).toBe(0);
    expect(hud.kpiW).toBe(hud.rightX);
    expect(hud.kpiBandRect.x + hud.kpiBandRect.w).toBe(hud.rightX);
    // the band matches the map's width (both are the left column)
    expect(hud.kpiBandRect.w).toBe(hud.mapRect.w);
  });

  it("there are exactly five equal, non-overlapping tiles inside the band", () => {
    const hud = computeHud(VW, VH);
    expect(KPI_TILE_COUNT).toBe(5);
    const rects = [];
    for (let i = 0; i < KPI_TILE_COUNT; i++) rects.push(hud.kpiTileRect(i));
    // every tile is inside the band
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(hud.kpiBandRect.x);
      expect(r.x + r.w).toBeLessThanOrEqual(hud.kpiBandRect.x + hud.kpiBandRect.w);
      expect(r.y).toBeGreaterThanOrEqual(hud.kpiBandRect.y);
      expect(r.y + r.h).toBeLessThanOrEqual(hud.kpiBandRect.y + hud.kpiBandRect.h);
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
    // tiles share the same row (same y, same height)
    for (const r of rects) {
      expect(r.y).toBe(rects[0].y);
      expect(r.h).toBeGreaterThanOrEqual(rects[0].h - 1);
      expect(r.h).toBeLessThanOrEqual(rects[0].h + 1);
    }
    // left→right, non-overlapping with a >= gap-1 separation between neighbours
    for (let i = 1; i < KPI_TILE_COUNT; i++) {
      expect(rects[i].x).toBeGreaterThan(rects[i - 1].x);
      const gap = rects[i].x - (rects[i - 1].x + rects[i - 1].w);
      expect(gap).toBeGreaterThanOrEqual(KPI_TILE_GAP - 1);
      expect(gap).toBeLessThanOrEqual(KPI_TILE_GAP + 1);
    }
    // tiles are near-equal width (integer flooring leaves ≤1px slack)
    const widths = rects.map((r) => r.w);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });

  it("every tile rect lands on integer pixels", () => {
    const hud = computeHud(VW, VH);
    for (let i = 0; i < KPI_TILE_COUNT; i++) {
      const r = hud.kpiTileRect(i);
      for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("the map keeps a usable height after the band shift on the design viewport", () => {
    const hud = computeHud(VW, VH);
    // the band ate KPI_BAND_H off the top of the map, but the map is still tall
    expect(hud.mapRect.h).toBeGreaterThanOrEqual(200);
    // and the band did not push the map past the bottom strip
    expect(hud.mapRect.y + hud.mapRect.h).toBeLessThanOrEqual(hud.stripY);
  });

  it("isPointOverHud guards the KPI band as opaque chrome", () => {
    const hud = computeHud(VW, VH);
    const t = hud.kpiTileRect(0);
    // a point inside the band (left column, below the bar, above the map) is HUD
    expect(isPointOverHud(hud, t.x + 5, hud.kpiY + 5)).toBe(true);
    // the open map below the band is NOT HUD
    expect(isPointOverHud(hud, t.x + 5, hud.mapY + 5)).toBe(false);
  });
});

describe("B-3 — KPI value formatters", () => {
  it("formatEconomy adds thousands separators and a g suffix", () => {
    expect(formatEconomy(0)).toBe("0g");
    expect(formatEconomy(284)).toBe("284g");
    expect(formatEconomy(2400)).toBe("2,400g");
    expect(formatEconomy(1234567)).toBe("1,234,567g");
    // rounds + clamps non-finite/negative to an honest 0g (never fabricated)
    expect(formatEconomy(2400.7)).toBe("2,401g");
    expect(formatEconomy(-5)).toBe("0g");
    expect(formatEconomy(Number.NaN)).toBe("0g");
  });

  it("formatPercent rounds a mean to a whole percent", () => {
    expect(formatPercent(71)).toBe("71%");
    expect(formatPercent(71.4)).toBe("71%");
    expect(formatPercent(71.6)).toBe("72%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(Number.NaN)).toBe("0%");
  });
});

describe("v4 — three docked regions (right panel / bottom strip / map)", () => {
  it("the right panel is a fixed-width column under the top chrome", () => {
    const hud = computeHud(VW, VH);
    expect(hud.rightX).toBe(VW - hud.rightW);
    expect(hud.rightTop).toBe(HUD_TOP_H);
    // full height under the top chrome
    expect(hud.rightRect.y).toBe(HUD_TOP_H);
    expect(hud.rightRect.y + hud.rightRect.h).toBeLessThanOrEqual(VH);
    // comfortably readable width (not the old cramped narrow column)
    expect(hud.rightW).toBeGreaterThanOrEqual(220);
  });

  it("the bottom agent strip spans the full width left of the right panel", () => {
    const hud = computeHud(VW, VH);
    expect(hud.stripY).toBe(VH - hud.stripH);
    expect(hud.stripY + hud.stripH).toBe(VH);
    // strip header + first card sit inside the strip band
    expect(hud.cardTop).toBeGreaterThanOrEqual(hud.stripY);
    const c0 = hud.cardRect(0, 6);
    expect(c0.y).toBeGreaterThanOrEqual(hud.stripY);
    expect(c0.y + c0.h).toBeLessThanOrEqual(VH);
  });

  it("the map fills the center-left area between chrome, panel and strip", () => {
    const hud = computeHud(VW, VH);
    expect(hud.mapRect.x).toBe(0);
    // B-3: the map starts below the KPI band, not at topH
    expect(hud.mapRect.y).toBe(HUD_TOP_H + KPI_BAND_H);
    // left of the right panel
    expect(hud.mapRect.x + hud.mapRect.w).toBeLessThanOrEqual(hud.rightX);
    // above the bottom strip
    expect(hud.mapRect.y + hud.mapRect.h).toBeLessThanOrEqual(hud.stripY);
    // the map is WIDER than the right panel (the agent column is gone)
    expect(hud.mapRect.w).toBeGreaterThan(hud.rightW);
  });

  it("the map rect uses integer pixels", () => {
    const hud = computeHud(VW, VH);
    for (const v of [hud.mapRect.x, hud.mapRect.y, hud.mapRect.w, hud.mapRect.h]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("v4 — conversation (top) + events (bottom) inside the right panel", () => {
  it("the conversation transcript docks in the right panel, above the feed", () => {
    const hud = computeHud(VW, VH);
    // inside the right panel horizontally
    expect(hud.transcriptX).toBeGreaterThanOrEqual(hud.rightX);
    expect(hud.transcriptX + hud.transcriptW).toBeLessThanOrEqual(hud.rightX + hud.rightW);
    // above the events feed (does not overlap it)
    expect(hud.transcriptY + hud.transcriptH).toBeLessThanOrEqual(hud.logY);
  });

  it("the events feed docks at the bottom of the right panel", () => {
    const hud = computeHud(VW, VH);
    expect(hud.logX).toBeGreaterThanOrEqual(hud.rightX);
    expect(hud.logX + hud.logW).toBeLessThanOrEqual(hud.rightX + hud.rightW);
    // the feed is BELOW the conversation (events beneath chat)
    expect(hud.logY).toBeGreaterThanOrEqual(hud.transcriptY);
    expect(hud.logY + hud.logH).toBeLessThanOrEqual(VH);
  });

  it("transcript rect uses integer pixel positions and matches its fields", () => {
    const hud = computeHud(VW, VH);
    for (const v of [hud.transcriptX, hud.transcriptY, hud.transcriptW, hud.transcriptH]) {
      expect(Number.isInteger(v)).toBe(true);
    }
    expect(hud.transcriptRect).toEqual({
      x: hud.transcriptX,
      y: hud.transcriptY,
      w: hud.transcriptW,
      h: hud.transcriptH,
    });
  });
});

describe("v4 — trace panel + showcase strip overlay the conversation region", () => {
  it("the trace panel sits inside the right panel, above the feed", () => {
    const hud = computeHud(VW, VH);
    expect(hud.panelX).toBeGreaterThanOrEqual(hud.rightX);
    expect(hud.panelX + hud.panelW).toBeLessThanOrEqual(hud.rightX + hud.rightW);
    expect(hud.panelY).toBeGreaterThanOrEqual(HUD_TOP_H);
    expect(hud.panelY + hud.panelH).toBeLessThanOrEqual(hud.logY);
  });

  it("the close button lives inside the trace panel", () => {
    const hud = computeHud(VW, VH);
    expect(hud.panelCloseRect.x).toBeGreaterThanOrEqual(hud.panelRect.x);
    expect(hud.panelCloseRect.x + hud.panelCloseRect.w).toBeLessThanOrEqual(
      hud.panelRect.x + hud.panelRect.w,
    );
  });

  it("the party/governance strip is a slim banner stacked above the transcript", () => {
    const hud = computeHud(VW, VH);
    expect(hud.partyX).toBe(hud.transcriptX);
    expect(hud.partyW).toBe(hud.transcriptW);
    // the strip sits at the TOP of the conversation region; the transcript
    // starts BELOW it (they never overlap)
    expect(hud.partyY).toBeLessThan(hud.transcriptY);
    expect(hud.transcriptY).toBeGreaterThanOrEqual(hud.partyY + hud.partyH);
    // a slim banner — never taller than the transcript region beneath it
    expect(hud.partyH).toBeLessThanOrEqual(hud.transcriptH);
  });
});

describe("v4 — bottom strip card layout", () => {
  it("cards lay out LEFT→RIGHT in a single row at the strip top", () => {
    const hud = computeHud(VW, VH);
    const a = hud.cardRect(0, 6);
    const b = hud.cardRect(1, 6);
    expect(b.x).toBeGreaterThan(a.x); // horizontal, not vertical
    expect(a.y).toBe(b.y); // same row
    expect(a.w).toBe(hud.cardW);
  });

  it("a scroll page holds at least a few cards on a desktop viewport", () => {
    const hud = computeHud(VW, VH);
    // every card that fits the page sits left of the right panel
    const perPage = hud.cardsPerPage();
    expect(perPage).toBeGreaterThanOrEqual(3);
    const last = hud.cardRect(perPage - 1, perPage);
    expect(last.x + last.w).toBeLessThanOrEqual(hud.rightX);
  });

  it("at least a few cards fit before the right panel on a desktop viewport", () => {
    const hud = computeHud(VW, VH);
    let visible = 0;
    for (let i = 0; i < 26; i++) {
      const r = hud.cardRect(i, 26);
      if (r.x + r.w > hud.rightX) break;
      visible++;
    }
    expect(visible).toBeGreaterThanOrEqual(3);
  });

  it("cardHeight is positive and fits inside the strip body", () => {
    const hud = computeHud(VW, VH);
    for (const count of [1, 6, 26]) {
      const ch = hud.cardHeight(count);
      expect(ch).toBeGreaterThan(0);
      expect(ch).toBeLessThanOrEqual(hud.stripH);
    }
  });
});

describe("isPointOverHud — chrome click-through guard", () => {
  it("returns true over the top chrome, right panel, and bottom strip", () => {
    const hud = computeHud(VW, VH);
    expect(isPointOverHud(hud, 200, 10)).toBe(true); // top chrome
    expect(isPointOverHud(hud, hud.rightX + 20, 400)).toBe(true); // right panel
    expect(isPointOverHud(hud, 200, hud.stripY + 20)).toBe(true); // bottom strip
  });

  it("returns false over the open map area", () => {
    const hud = computeHud(VW, VH);
    const cx = Math.round(hud.mapRect.x + hud.mapRect.w / 2);
    const cy = Math.round(hud.mapRect.y + hud.mapRect.h / 2);
    expect(isPointOverHud(hud, cx, cy)).toBe(false);
  });
});

describe("v4 (Wave 2) — unionRect", () => {
  it("covers both input rects exactly", () => {
    const a = { x: 10, y: 10, w: 20, h: 20 };
    const b = { x: 25, y: 40, w: 30, h: 10 };
    const u = unionRect(a, b);
    expect(u.x).toBe(10);
    expect(u.y).toBe(10);
    expect(u.x + u.w).toBe(55); // max(30, 55)
    expect(u.y + u.h).toBe(50); // max(30, 50)
  });

  it("the union of the showcase strip and the transcript covers both", () => {
    const hud = computeHud(VW, VH);
    const u = unionRect(hud.partyRect, hud.transcriptRect);
    for (const r of [hud.partyRect, hud.transcriptRect]) {
      expect(u.x).toBeLessThanOrEqual(r.x);
      expect(u.y).toBeLessThanOrEqual(r.y);
      expect(u.x + u.w).toBeGreaterThanOrEqual(r.x + r.w);
      expect(u.y + u.h).toBeGreaterThanOrEqual(r.y + r.h);
    }
    expect(Number.isInteger(u.x) && Number.isInteger(u.y)).toBe(true);
    expect(Number.isInteger(u.w) && Number.isInteger(u.h)).toBe(true);
  });
});

describe("hit testing (scene-level click resolution)", () => {
  it("pointInRect is inclusive of edges", () => {
    const r = { x: 10, y: 10, w: 20, h: 10 };
    expect(pointInRect(10, 10, r)).toBe(true);
    expect(pointInRect(30, 20, r)).toBe(true);
    expect(pointInRect(31, 20, r)).toBe(false);
    expect(pointInRect(15, 9, r)).toBe(false);
  });

  it("cardIndexAt resolves the card under a point and misses elsewhere", () => {
    const hud = computeHud(VW, VH);
    const r0 = hud.cardRect(0, 3);
    const r2 = hud.cardRect(2, 3);
    expect(hud.cardIndexAt(r0.x + 5, r0.y + 5, 3)).toBe(0);
    expect(hud.cardIndexAt(r2.x + 5, r2.y + 5, 3)).toBe(2);
    expect(hud.cardIndexAt(r0.x + 5, r0.y - 30, 3)).toBeNull(); // above the strip
    expect(hud.cardIndexAt(r0.x + 5, 2, 3)).toBeNull(); // in the top bar
    expect(hud.cardIndexAt(r0.x + 5, r0.y + 5, 0)).toBeNull(); // no agents yet
  });

  it("the design-size wrapper still resolves cards", () => {
    const r0 = cardRect(0, 3);
    expect(cardIndexAt(r0.x + 5, r0.y + 5, 3)).toBe(0);
    expect(cardHeight(3)).toBeGreaterThan(0);
  });

  it("feedLineIndexAt maps points to feed lines and misses outside", () => {
    const hud = computeHud(VW, VH);
    const r0 = hud.feedLineRect(0);
    const rLast = hud.feedLineRect(LOG_LINES - 1);
    expect(hud.feedLineIndexAt(r0.x + 4, r0.y + 4)).toBe(0);
    expect(hud.feedLineIndexAt(rLast.x + 4, rLast.y + 4)).toBe(LOG_LINES - 1);
    expect(hud.feedLineIndexAt(r0.x + 4, hud.logY - 40)).toBeNull(); // above feed
    expect(hud.feedLineIndexAt(10, r0.y + 4)).toBeNull(); // left of the right panel
  });

  it("design-size feed wrapper still resolves lines", () => {
    const r0 = feedLineRect(0);
    expect(feedLineIndexAt(r0.x + 4, r0.y + 4)).toBe(0);
    expect(feedLineIndexAt(r0.x + 4, LOG_Y - 40)).toBeNull();
  });

  it("cards and feed lines never share a hit region", () => {
    const hud = computeHud(VW, VH);
    for (let i = 0; i < LOG_LINES; i++) {
      const r = hud.feedLineRect(i);
      expect(hud.cardIndexAt(r.x + 2, r.y + 2, 6)).toBeNull();
    }
  });
});
