/**
 * Pure SpaceCon card-style helpers — the FSM state badge, action-verb color,
 * and the SINGLE energy-color rule (design §4: >55% / >25% boundaries). These
 * map plain data → theme tokens, so they're verified headlessly against the
 * design tokens with no Phaser.
 */
import { describe, expect, it } from "vitest";
import { actionVerbColor, energyLevelColor, stateBadge } from "../../src/obs/cardStyle";
import {
  brand400,
  cyan300,
  ink400,
  p1,
  p2,
  positive500,
  tintExec,
  tintIdle,
  tintThink,
} from "../../src/obs/theme";

describe("stateBadge — FSM badge color + tint (design §4)", () => {
  it("EXECUTING → positive500 on the exec tint", () => {
    const b = stateBadge("EXECUTING");
    expect(b.label).toBe("EXECUTING");
    expect(b.color).toBe(positive500.num);
    expect(b.tint).toEqual(tintExec);
  });

  it("THINKING → p2 (amber) on the think tint", () => {
    const b = stateBadge("THINKING");
    expect(b.label).toBe("THINKING");
    expect(b.color).toBe(p2.num);
    expect(b.tint).toEqual(tintThink);
  });

  it("IDLE → ink400 on the idle tint", () => {
    const b = stateBadge("IDLE");
    expect(b.label).toBe("IDLE");
    expect(b.color).toBe(ink400.num);
    expect(b.tint).toEqual(tintIdle);
  });

  it("any unknown FSM falls back to the IDLE style (no throw)", () => {
    const b = stateBadge("SOME_FUTURE_STATE");
    expect(b.label).toBe("IDLE");
    expect(b.color).toBe(ink400.num);
    expect(b.tint).toEqual(tintIdle);
  });
});

describe("actionVerbColor — color by verb (design §4)", () => {
  it("TALK_TO / TALK_ABOUT (TALK_*) → cyan300", () => {
    expect(actionVerbColor("TALK_TO")).toBe(cyan300.num);
    expect(actionVerbColor("TALK_ABOUT")).toBe(cyan300.num);
    expect(actionVerbColor("TALK")).toBe(cyan300.num);
  });

  it("WAIT → ink400", () => {
    expect(actionVerbColor("WAIT")).toBe(ink400.num);
  });

  it("everything else (MOVE_TO / HARVEST / PLANT / …) → brand400", () => {
    expect(actionVerbColor("MOVE_TO")).toBe(brand400.num);
    expect(actionVerbColor("HARVEST")).toBe(brand400.num);
    expect(actionVerbColor("PLANT")).toBe(brand400.num);
    expect(actionVerbColor("")).toBe(brand400.num);
    // "WAITING" is not exactly "WAIT" → not the WAIT branch
    expect(actionVerbColor("WAITING")).toBe(brand400.num);
  });
});

describe("energyLevelColor — the ONE energy-color rule (design §4: >55% / >25%)", () => {
  it("ratio > 0.55 → positive500", () => {
    expect(energyLevelColor(1)).toBe(positive500.num);
    expect(energyLevelColor(0.7)).toBe(positive500.num);
    expect(energyLevelColor(0.56)).toBe(positive500.num);
  });

  it("the 0.55 boundary is amber, not positive (strict >55%)", () => {
    expect(energyLevelColor(0.55)).toBe(p2.num);
  });

  it("0.25 < ratio ≤ 0.55 → p2 (amber)", () => {
    expect(energyLevelColor(0.55)).toBe(p2.num);
    expect(energyLevelColor(0.4)).toBe(p2.num);
    expect(energyLevelColor(0.26)).toBe(p2.num);
  });

  it("the 0.25 boundary is red, not amber (strict >25%)", () => {
    expect(energyLevelColor(0.25)).toBe(p1.num);
  });

  it("ratio ≤ 0.25 → p1 (red)", () => {
    expect(energyLevelColor(0.25)).toBe(p1.num);
    expect(energyLevelColor(0.1)).toBe(p1.num);
    expect(energyLevelColor(0)).toBe(p1.num);
  });
});
