import { describe, expect, it } from "vitest";
import { PERSONAS } from "../../src/agents/personas";
import { generateMap, HOMESTEAD_DOORS, HOMESTEADS } from "../../src/world/map";

const map = generateMap();

describe("personas live at their homesteads", () => {
  it("each persona starts on its homestead door (a path tile)", () => {
    for (const p of PERSONAS) {
      const door = HOMESTEAD_DOORS[p.id];
      expect(door, `homestead for ${p.id}`).toBeDefined();
      expect(p.start).toEqual(door);
      expect(map.tiles[p.start.y][p.start.x]).toBe("path");
    }
  });

  it("every persona has a distinct start", () => {
    const keys = PERSONAS.map((p) => `${p.start.x},${p.start.y}`);
    expect(new Set(keys).size).toBe(PERSONAS.length);
  });

  it("the nearest bed to each start is that homestead's own bed", () => {
    const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const beds = map.landmarks.filter((l) => l.kind === "bed").map((l) => l.pos);
    for (const h of HOMESTEADS) {
      const nearest = [...beds].sort((a, b) => cheb(h.door, a) - cheb(h.door, b))[0];
      expect(nearest, `nearest bed for ${h.id}`).toEqual(h.bed);
    }
  });
});
