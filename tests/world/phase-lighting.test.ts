/**
 * Day/night ambient lighting palette (src/config.ts) — pure data the WorldScene
 * paints onto a single full-map overlay Rectangle per phase. Headless-testable
 * with no Phaser dependency. The night-alpha hard cap (≤0.40) is the load-
 * bearing legibility invariant; these tests pin it.
 */
import { describe, expect, it } from "vitest";
import { PHASE_TINTS, phaseTint } from "../../src/config";
import type { Phase } from "@contracts/types";

const ALL_PHASES: Phase[] = ["morning", "afternoon", "evening", "night"];
const red = (c: number): number => (c >> 16) & 0xff;
const blue = (c: number): number => c & 0xff;

describe("PHASE_TINTS ambient palette", () => {
  it("defines a tint for all four phases", () => {
    for (const p of ALL_PHASES) {
      expect(PHASE_TINTS[p]).toBeDefined();
      expect(phaseTint(p)).toBe(PHASE_TINTS[p]);
    }
    expect(Object.keys(PHASE_TINTS).sort()).toEqual([...ALL_PHASES].sort());
  });

  it("afternoon (midday) is a transparent no-op", () => {
    expect(phaseTint("afternoon").alpha).toBe(0);
  });

  it("every phase alpha stays in [0, 0.40] (night legibility hard cap)", () => {
    for (const p of ALL_PHASES) {
      const a = phaseTint(p).alpha;
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(0.4);
    }
  });

  it("night is the darkest wash — heavier than evening", () => {
    expect(phaseTint("night").alpha).toBeGreaterThan(phaseTint("evening").alpha);
  });

  it("evening reads warm (red-dominant) and night reads cool (blue-dominant)", () => {
    const evening = phaseTint("evening").color;
    expect(red(evening)).toBeGreaterThan(blue(evening));
    const night = phaseTint("night").color;
    expect(blue(night)).toBeGreaterThan(red(night));
  });
});
