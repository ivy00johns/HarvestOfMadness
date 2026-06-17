/**
 * Unit tests for zoomFactorForWheelDelta — the delta-proportional camera zoom
 * helper introduced in src/config.ts.
 *
 * These are pure math tests (no Phaser dependency) that verify the sensitivity
 * constant and the helper's contract:
 *   - dy > 0 (scroll down) → factor < 1 (zoom out)
 *   - dy < 0 (scroll up)   → factor > 1 (zoom in)
 *   - dy = 0               → factor = 1 (no change)
 *   - magnitude is monotonic (bigger delta → bigger change)
 *   - a single mouse notch (|dy| ≈ 100) lands in a gentle range [1.10, 1.25]
 *     (and its reciprocal for the opposite direction), not a jarring ×2+.
 */
import { describe, expect, it } from "vitest";
import {
  ZOOM_WHEEL_SENSITIVITY,
  zoomFactorForWheelDelta,
} from "../../src/config";

describe("zoomFactorForWheelDelta — contract", () => {
  it("dy=0 returns exactly 1 (no zoom change)", () => {
    expect(zoomFactorForWheelDelta(0)).toBe(1);
  });

  it("dy>0 (scroll down) returns factor < 1 (zoom out)", () => {
    expect(zoomFactorForWheelDelta(100)).toBeLessThan(1);
    expect(zoomFactorForWheelDelta(10)).toBeLessThan(1);
    expect(zoomFactorForWheelDelta(1)).toBeLessThan(1);
  });

  it("dy<0 (scroll up) returns factor > 1 (zoom in)", () => {
    expect(zoomFactorForWheelDelta(-100)).toBeGreaterThan(1);
    expect(zoomFactorForWheelDelta(-10)).toBeGreaterThan(1);
    expect(zoomFactorForWheelDelta(-1)).toBeGreaterThan(1);
  });

  it("magnitude is monotonic: larger |dy| → larger deviation from 1", () => {
    // zoom-out direction
    const f10 = zoomFactorForWheelDelta(10);
    const f100 = zoomFactorForWheelDelta(100);
    const f200 = zoomFactorForWheelDelta(200);
    expect(f10).toBeGreaterThan(f100);  // f10 closer to 1 than f100
    expect(f100).toBeGreaterThan(f200);

    // zoom-in direction (all > 1, but larger |dy| → further from 1)
    const fi10 = zoomFactorForWheelDelta(-10);
    const fi100 = zoomFactorForWheelDelta(-100);
    const fi200 = zoomFactorForWheelDelta(-200);
    expect(fi10).toBeLessThan(fi100);
    expect(fi100).toBeLessThan(fi200);
  });

  it("zoom-in and zoom-out are exact reciprocals (symmetric around dy=0)", () => {
    const out = zoomFactorForWheelDelta(100);
    const inn = zoomFactorForWheelDelta(-100);
    expect(out * inn).toBeCloseTo(1, 10);
  });

  it("a single mouse notch (dy≈100) gives a gentle zoom step in [1.10, 1.25]", () => {
    // This asserts that the chosen ZOOM_WHEEL_SENSITIVITY constant is tuned
    // correctly — not so weak (< 1.10) that the wheel feels broken, not so
    // strong (> 1.25) that it lurches on a single notch.
    const inn = zoomFactorForWheelDelta(-100); // zoom in
    const out = zoomFactorForWheelDelta(100);  // zoom out
    expect(inn).toBeGreaterThanOrEqual(1.10);
    expect(inn).toBeLessThanOrEqual(1.25);
    expect(out).toBeGreaterThanOrEqual(1 / 1.25);
    expect(out).toBeLessThanOrEqual(1 / 1.10);
  });

  it("a tiny trackpad tick (dy≈10) gives a very small step (< 1.02 change)", () => {
    const inn = zoomFactorForWheelDelta(-10);
    expect(inn).toBeGreaterThan(1);
    expect(inn).toBeLessThan(1.02);
  });

  it("sensitivity parameter can be overridden", () => {
    // With zero sensitivity the factor must be 1 regardless of dy.
    expect(zoomFactorForWheelDelta(100, 0)).toBe(1);
    // With higher sensitivity the step is larger.
    const gentle = zoomFactorForWheelDelta(-100, ZOOM_WHEEL_SENSITIVITY);
    const aggressive = zoomFactorForWheelDelta(-100, ZOOM_WHEEL_SENSITIVITY * 2);
    expect(aggressive).toBeGreaterThan(gentle);
  });
});
