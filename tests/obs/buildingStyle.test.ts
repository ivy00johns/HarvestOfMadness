/**
 * Pure unit tests for buildingStyle — the centralised kind→{tint,sign} map.
 * No Phaser dependency: runs entirely headless via vitest.
 */
import { describe, expect, it } from "vitest";
import { buildingStyle } from "../../src/obs/buildingStyle";
import type { BuildingKind } from "../../src/obs/buildingStyle";

const ALL_KINDS: BuildingKind[] = ["house", "shop", "tavern", "library", "school"];

describe("buildingStyle", () => {
  it("every known kind returns a non-empty sign and a tint number", () => {
    for (const kind of ALL_KINDS) {
      const style = buildingStyle(kind);
      expect(typeof style.tint, `${kind}.tint must be a number`).toBe("number");
      expect(style.sign, `${kind}.sign must be non-empty`).toBeTruthy();
      expect(style.sign.length, `${kind}.sign must have content`).toBeGreaterThan(0);
    }
  });

  it("distinct kinds produce distinct signs", () => {
    const signs = ALL_KINDS.map((k) => buildingStyle(k).sign);
    const unique = new Set(signs);
    expect(unique.size).toBe(ALL_KINDS.length);
  });

  it("distinct kinds produce distinct tints", () => {
    const tints = ALL_KINDS.map((k) => buildingStyle(k).tint);
    const unique = new Set(tints);
    expect(unique.size).toBe(ALL_KINDS.length);
  });

  it("house tint is 0xffffff (neutral / no tint)", () => {
    expect(buildingStyle("house").tint).toBe(0xffffff);
  });

  it("shop sign is 🛒", () => {
    expect(buildingStyle("shop").sign).toBe("🛒");
  });

  it("tavern sign is 🍺", () => {
    expect(buildingStyle("tavern").sign).toBe("🍺");
  });

  it("unknown kind falls back to house style without throwing", () => {
    const style = buildingStyle("mystery_building");
    expect(style).toBeDefined();
    expect(style.sign).toBeTruthy();
    expect(typeof style.tint).toBe("number");
  });

  it("tints are valid Phaser-compatible hex numbers (0..0xffffff)", () => {
    for (const kind of ALL_KINDS) {
      const { tint } = buildingStyle(kind);
      expect(tint).toBeGreaterThanOrEqual(0);
      expect(tint).toBeLessThanOrEqual(0xffffff);
    }
  });
});
