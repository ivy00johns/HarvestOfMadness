/**
 * Pure unit tests for hamletStyle — the position-derived per-hamlet roof/wall
 * tint used to give the five neighbourhoods distinct color identities in the
 * cutaway render. No Phaser dependency: runs entirely headless via vitest.
 *
 * This is a SEPARATE function from buildingStyle (kind→tint); buildingStyle
 * keeps house=0xffffff. The hamlet tint is derived from a footprint CENTER.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOMESTEADS } from "../../src/world/map";
import {
  HAMLET_ROOF_TINTS,
  hamletOf,
  hamletRoofTint,
} from "../../src/obs/hamletStyle";
import type { Hamlet } from "../../src/obs/hamletStyle";

/** footprint CENTER (tile coords) — matches the WorldScene wiring formula. */
function centerOf(h: (typeof HOMESTEADS)[number]): { cx: number; cy: number } {
  return {
    cx: h.house.x + (h.size.w - 1) / 2,
    cy: h.house.y + (h.size.h - 1) / 2,
  };
}

/** Expected hamlet for each of the 15 real homes (pins the geography bands). */
const EXPECTED: Record<string, Hamlet> = {
  brix: "nw", ford: "nw", wren: "nw",
  dora: "ne", gus: "ne", clem: "ne",
  fern: "sw", nell: "sw", sage: "sw",
  rusty: "se", moss: "se", zola: "se",
  juno: "central", pim: "central", odo: "central",
};

describe("hamletStyle", () => {
  it("classifies all 15 real homes into their expected hamlet", () => {
    expect(HOMESTEADS.length).toBe(15);
    for (const h of HOMESTEADS) {
      const { cx, cy } = centerOf(h);
      expect(hamletOf(cx, cy), `${h.id} center (${cx},${cy})`).toBe(
        EXPECTED[h.id],
      );
    }
  });

  it("each hamlet's 3 homes resolve to ONE shared tint (cohesion)", () => {
    const byHamlet = new Map<Hamlet, Set<number>>();
    for (const h of HOMESTEADS) {
      const { cx, cy } = centerOf(h);
      const ham = hamletOf(cx, cy);
      const set = byHamlet.get(ham) ?? new Set<number>();
      set.add(hamletRoofTint(cx, cy));
      byHamlet.set(ham, set);
    }
    expect(byHamlet.size).toBe(5);
    for (const [ham, tints] of byHamlet) {
      expect(tints.size, `${ham} homes must share one tint`).toBe(1);
    }
  });

  it("yields 5 DISTINCT tints, all valid Phaser hex (0..0xffffff)", () => {
    const hamlets: Hamlet[] = ["nw", "ne", "sw", "se", "central"];
    const tints = hamlets.map((h) => HAMLET_ROOF_TINTS[h]);
    expect(new Set(tints).size).toBe(5);
    for (const ham of hamlets) {
      const tint = HAMLET_ROOF_TINTS[ham];
      expect(typeof tint, `${ham} tint is a number`).toBe("number");
      expect(tint).toBeGreaterThanOrEqual(0);
      expect(tint).toBeLessThanOrEqual(0xffffff);
    }
  });

  it("hamletRoofTint === HAMLET_ROOF_TINTS[hamletOf(...)] for every home", () => {
    for (const h of HOMESTEADS) {
      const { cx, cy } = centerOf(h);
      expect(hamletRoofTint(cx, cy)).toBe(HAMLET_ROOF_TINTS[hamletOf(cx, cy)]);
    }
  });

  it("is pure / deterministic — same input → same output", () => {
    for (const h of HOMESTEADS) {
      const { cx, cy } = centerOf(h);
      expect(hamletRoofTint(cx, cy)).toBe(hamletRoofTint(cx, cy));
      expect(hamletOf(cx, cy)).toBe(hamletOf(cx, cy));
    }
    // boundary sanity: the exact band edges classify as documented.
    expect(hamletOf(49, 49)).toBe("nw");
    expect(hamletOf(49, 50)).toBe("sw");
    expect(hamletOf(111, 49)).toBe("ne");
    expect(hamletOf(111, 50)).toBe("se");
    expect(hamletOf(50, 0)).toBe("central");
    expect(hamletOf(110, 0)).toBe("central");
  });

  it("module source contains no Math.random / Date (determinism law)", () => {
    const src = readFileSync(
      new URL("../../src/obs/hamletStyle.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/\bDate\b/);
  });
});
