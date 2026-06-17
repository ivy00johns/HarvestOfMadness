/**
 * HUD layout math (contract rule 14): minimum effective 12px fonts at zoom 1,
 * integer pixel positions, and panels that never overlap each other or run
 * off the 768x576 logical canvas. Pure module — no Phaser needed.
 */
import { describe, expect, it } from "vitest";
import {
  BADGE_ROW_Y,
  CARD_GAP,
  CARD_TOP,
  CARD_W,
  CARD_X,
  FONT_SIZE_BASE,
  FONT_SIZE_SMALL,
  FONT_SIZE_TITLE,
  HUD_H,
  HUD_TOP_H,
  HUD_W,
  LOG_H,
  LOG_LINES,
  LOG_LINE_H,
  LOG_W,
  LOG_X,
  LOG_Y,
  PANEL_CLOSE_RECT,
  PANEL_H,
  PANEL_RECT,
  PANEL_W,
  PANEL_X,
  PANEL_Y,
  TOPBAR_H,
  cardHeight,
  cardIndexAt,
  cardRect,
  feedLineIndexAt,
  feedLineRect,
  pointInRect,
} from "../../src/obs/layout";

describe("contract rule 14 — readable text", () => {
  it("every HUD font size is ≥ 12px effective at zoom 1", () => {
    expect(FONT_SIZE_SMALL).toBeGreaterThanOrEqual(12);
    expect(FONT_SIZE_BASE).toBeGreaterThanOrEqual(12);
    expect(FONT_SIZE_TITLE).toBeGreaterThanOrEqual(12);
  });

  it("feed line height fits the smallest font without clipping", () => {
    expect(LOG_LINE_H).toBeGreaterThanOrEqual(FONT_SIZE_SMALL);
  });

  it("all layout constants are integers (integer pixel positions)", () => {
    const values = [
      HUD_W, HUD_H, TOPBAR_H, BADGE_ROW_Y, HUD_TOP_H,
      CARD_X, CARD_W, CARD_TOP, CARD_GAP,
      LOG_X, LOG_Y, LOG_W, LOG_H, LOG_LINE_H,
      PANEL_X, PANEL_Y, PANEL_W, PANEL_H,
    ];
    for (const v of values) expect(Number.isInteger(v)).toBe(true);
  });

  it("card rects land on integer pixels for any sane agent count", () => {
    for (const count of [1, 2, 3, 4, 5, 6]) {
      for (let i = 0; i < count; i++) {
        const r = cardRect(i, count);
        expect(Number.isInteger(r.x)).toBe(true);
        expect(Number.isInteger(r.y)).toBe(true);
        expect(Number.isInteger(r.h)).toBe(true);
      }
    }
  });
});

describe("region geometry — nothing overlaps, everything on screen", () => {
  it("logical canvas matches the v2 map (768x576)", () => {
    expect(HUD_W).toBe(768);
    expect(HUD_H).toBe(576);
  });

  it("feed and trace panel stop left of the card column", () => {
    expect(LOG_X + LOG_W).toBeLessThanOrEqual(CARD_X);
    expect(PANEL_X + PANEL_W).toBeLessThanOrEqual(CARD_X);
  });

  it("trace panel sits between the badge row and the feed", () => {
    expect(PANEL_Y).toBeGreaterThanOrEqual(HUD_TOP_H);
    expect(PANEL_Y + PANEL_H).toBeLessThanOrEqual(LOG_Y);
    expect(LOG_Y + LOG_H).toBeLessThanOrEqual(HUD_H);
  });

  it("the close button lives inside the panel", () => {
    expect(PANEL_CLOSE_RECT.x).toBeGreaterThanOrEqual(PANEL_RECT.x);
    expect(PANEL_CLOSE_RECT.x + PANEL_CLOSE_RECT.w).toBeLessThanOrEqual(
      PANEL_RECT.x + PANEL_RECT.w,
    );
  });

  it("the full card column fits on screen for 1..6 agents", () => {
    for (const count of [1, 2, 3, 4, 5, 6]) {
      const last = cardRect(count - 1, count);
      expect(last.y + last.h).toBeLessThanOrEqual(HUD_H);
      expect(cardHeight(count)).toBeGreaterThan(0);
    }
  });

  it("compact cards kick in for 4+ agents", () => {
    expect(cardHeight(3)).toBeGreaterThan(cardHeight(4));
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
    const r0 = cardRect(0, 3);
    const r2 = cardRect(2, 3);
    expect(cardIndexAt(r0.x + 5, r0.y + 5, 3)).toBe(0);
    expect(cardIndexAt(r2.x + 5, r2.y + 5, 3)).toBe(2);
    expect(cardIndexAt(r0.x - 10, r0.y + 5, 3)).toBeNull(); // left of column
    expect(cardIndexAt(r0.x + 5, 2, 3)).toBeNull(); // in the top bar
    expect(cardIndexAt(r0.x + 5, r0.y + 5, 0)).toBeNull(); // no agents yet
  });

  it("feedLineIndexAt maps points to feed lines and misses outside", () => {
    const r0 = feedLineRect(0);
    const rLast = feedLineRect(LOG_LINES - 1);
    expect(feedLineIndexAt(r0.x + 4, r0.y + 4)).toBe(0);
    expect(feedLineIndexAt(rLast.x + 4, rLast.y + 4)).toBe(LOG_LINES - 1);
    expect(feedLineIndexAt(r0.x + 4, LOG_Y - 10)).toBeNull(); // above the feed
    expect(feedLineIndexAt(CARD_X + 5, r0.y + 4)).toBeNull(); // card column
  });

  it("cards and feed lines never share a hit region", () => {
    for (let i = 0; i < LOG_LINES; i++) {
      const r = feedLineRect(i);
      expect(cardIndexAt(r.x + 2, r.y + 2, 6)).toBeNull();
    }
  });
});
