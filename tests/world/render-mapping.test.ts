/**
 * Pure LPC frame-mapping helpers (src/world/render.ts) — these drive which
 * sheet frame WorldScene paints per tile, headless-testable without Phaser.
 */
import { describe, expect, it } from "vitest";
import {
  FENCE_FRAMES,
  SOIL_FRAMES,
  WATER_FRAMES,
  cropStripFrame,
  fenceFrame,
  soilFrame,
  waterFrame,
  type NeighborProbe,
} from "../../src/world/render";
import { MAP_HEIGHT, MAP_WIDTH } from "@contracts/types";

/** probe over an explicit member set, relative to an origin */
function probeAt(
  members: ReadonlySet<string>,
  x: number,
  y: number,
): NeighborProbe {
  return (dx, dy) => members.has(`${x + dx},${y + dy}`);
}

/** rect membership set, inclusive bounds */
function rect(x0: number, y0: number, x1: number, y1: number): Set<string> {
  const s = new Set<string>();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) s.add(`${x},${y}`);
  }
  return s;
}

describe("cropStripFrame (5-frame growth strip)", () => {
  it("maps stage 0 to the seed frame", () => {
    expect(cropStripFrame(0, 4, false)).toBe(0);
    expect(cropStripFrame(0, 8, false)).toBe(0);
  });

  it("maps a ready crop to frame 4 regardless of stage math", () => {
    expect(cropStripFrame(4, 4, true)).toBe(4);
    expect(cropStripFrame(99, 8, true)).toBe(4);
  });

  it("never returns frame 4 for an unready crop", () => {
    for (const days of [4, 6, 8]) {
      for (let stage = 0; stage <= days; stage++) {
        expect(cropStripFrame(stage, days, false)).toBeLessThanOrEqual(3);
      }
    }
  });

  it("is monotonic in stage (a crop never visually shrinks)", () => {
    for (const days of [4, 6, 8]) {
      let prev = -1;
      for (let stage = 0; stage < days; stage++) {
        const f = cropStripFrame(stage, days, false);
        expect(f).toBeGreaterThanOrEqual(prev);
        prev = f;
      }
    }
  });
});

describe("waterFrame (3x4 contract pond at (7,2)-(9,5))", () => {
  const pond = rect(7, 2, 9, 5);
  const frameAt = (x: number, y: number): number =>
    waterFrame(probeAt(pond, x, y));

  it("maps the four pond corners to shore corners", () => {
    expect(frameAt(7, 2)).toBe(WATER_FRAMES.TL);
    expect(frameAt(9, 2)).toBe(WATER_FRAMES.TR);
    expect(frameAt(7, 5)).toBe(WATER_FRAMES.BL);
    expect(frameAt(9, 5)).toBe(WATER_FRAMES.BR);
  });

  it("maps edge tiles to shore edges", () => {
    expect(frameAt(8, 2)).toBe(WATER_FRAMES.T);
    expect(frameAt(8, 5)).toBe(WATER_FRAMES.B);
    expect(frameAt(7, 3)).toBe(WATER_FRAMES.L);
    expect(frameAt(9, 4)).toBe(WATER_FRAMES.R);
  });

  it("maps fully surrounded tiles to animated open water", () => {
    expect(frameAt(8, 3)).toBe(WATER_FRAMES.ANIM[0]);
    expect(frameAt(8, 4)).toBe(WATER_FRAMES.ANIM[0]);
  });
});

describe("soilFrame (8x6 contract field at (8,8)-(15,13))", () => {
  const field = rect(8, 8, 15, 13);
  const frameAt = (x: number, y: number): number =>
    soilFrame(probeAt(field, x, y));

  it("maps corners, edges and interior of the field block", () => {
    expect(frameAt(8, 8)).toBe(SOIL_FRAMES.TL);
    expect(frameAt(15, 13)).toBe(SOIL_FRAMES.BR);
    expect(frameAt(10, 8)).toBe(SOIL_FRAMES.T);
    expect(frameAt(8, 10)).toBe(SOIL_FRAMES.L);
    expect(frameAt(10, 10)).toBe(SOIL_FRAMES.C);
  });

  it("treats tilled neighbours as field (caller passes a combined probe)", () => {
    // soilFrame itself is mask-only; the probe decides membership — a field
    // tile whose neighbours are all members stays an interior tile.
    expect(frameAt(12, 11)).toBe(SOIL_FRAMES.C);
  });
});

describe("fenceFrame (24x18 wall ring)", () => {
  it("posts at the four map corners", () => {
    expect(fenceFrame(0, 0, MAP_WIDTH, MAP_HEIGHT)).toBe(FENCE_FRAMES.POST);
    expect(fenceFrame(MAP_WIDTH - 1, 0, MAP_WIDTH, MAP_HEIGHT)).toBe(
      FENCE_FRAMES.POST,
    );
    expect(fenceFrame(0, MAP_HEIGHT - 1, MAP_WIDTH, MAP_HEIGHT)).toBe(
      FENCE_FRAMES.POST,
    );
    expect(fenceFrame(MAP_WIDTH - 1, MAP_HEIGHT - 1, MAP_WIDTH, MAP_HEIGHT)).toBe(
      FENCE_FRAMES.POST,
    );
  });

  it("horizontal rails on the top and bottom rows, verticals on the sides", () => {
    expect(fenceFrame(5, 0, MAP_WIDTH, MAP_HEIGHT)).toBe(FENCE_FRAMES.H);
    expect(fenceFrame(5, MAP_HEIGHT - 1, MAP_WIDTH, MAP_HEIGHT)).toBe(
      FENCE_FRAMES.H_LEGS,
    );
    expect(fenceFrame(0, 5, MAP_WIDTH, MAP_HEIGHT)).toBe(FENCE_FRAMES.V);
    expect(fenceFrame(MAP_WIDTH - 1, 5, MAP_WIDTH, MAP_HEIGHT)).toBe(
      FENCE_FRAMES.V,
    );
  });
});
