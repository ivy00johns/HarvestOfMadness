/**
 * Reserve-activation proof — Phase C · Slice C6.
 *
 * Pins the invariants of promoting three pre-zoned reserve lots (lot_n4/n5/n6)
 * into LIVE homesteads with three new townsfolk (juno/pim/odo) — the town's
 * first growth INWARD, toward the central commons. A future regression that
 * silently un-wires the activation (drops a persona, leaves a lot reserved,
 * mis-stamps a home) trips here.
 *
 * THE PAYOFF: each activated door's A* path to the tavern is strictly shorter
 * than the MINIMUM corner-homestead door→tavern A* path, so the shipped
 * distance-weighted attendance gradient finally differentiates (near folk
 * attend seeded gatherings reliably, far corners attend occasionally).
 *
 * Uses the real map + real World A* (the same pathfinder party-emergence's
 * reachability test uses), not hand coords.
 */
import { describe, expect, it } from "vitest";
import type { TileType, Vec2 } from "@contracts/types";
import { generateMap, HOMESTEADS, HOMESTEAD_DOORS, RESERVE_LOTS } from "../../src/world/map";
import { PERSONAS } from "../../src/agents/personas";
import { getWorld, resetWorldForTests } from "../../src/world/instance";

/** The three activated lots → live homesteads (a new central hamlet). */
const ACTIVATED = ["juno", "pim", "odo"] as const;

const map = generateMap();
const at = (p: Vec2): TileType => map.tiles[p.y][p.x];

describe("reserve activation — Greenhollow central hamlet (C6)", () => {
  it("each activated id is in BOTH HOMESTEADS and PERSONAS with start === its homestead door", () => {
    for (const id of ACTIVATED) {
      const home = HOMESTEADS.find((h) => h.id === id);
      expect(home, `${id} present in HOMESTEADS`).toBeDefined();
      const persona = PERSONAS.find((p) => p.id === id);
      expect(persona, `${id} present in PERSONAS`).toBeDefined();
      // The persona starts on its homestead door (and HOMESTEAD_DOORS derives it).
      expect(persona!.start).toEqual(home!.door);
      expect(persona!.start).toEqual(HOMESTEAD_DOORS[id]);
    }
  });

  it("each activated home is genuinely stamped: door-exterior path, 1 reachable bed, plot soil, footprint not grass", () => {
    for (const id of ACTIVATED) {
      const h = HOMESTEADS.find((hh) => hh.id === id)!;
      const x0 = h.house.x;
      const y0 = h.house.y;
      const x1 = h.house.x + h.size.w - 1;
      const y1 = h.house.y + h.size.h - 1;

      // -- door-gap is `floor`; its exterior neighbour (doorSide S) is a road --
      expect(at(h.door), `${id} door is floor`).toBe("floor");
      const ext: Vec2 = { x: h.door.x, y: h.door.y + 1 }; // doorSide S
      expect(at(ext), `${id} door exterior is a path`).toBe("path");

      // -- interior: EXACTLY 1 bedTile, reachable from the door via BFS --------
      let bedCount = 0;
      let theBed: Vec2 | null = null;
      for (let y = y0 + 1; y <= y1 - 1; y++)
        for (let x = x0 + 1; x <= x1 - 1; x++) {
          if (map.tiles[y][x] === "bedTile") {
            bedCount++;
            theBed = { x, y };
          }
        }
      expect(bedCount, `${id} has exactly 1 bedTile`).toBe(1);
      expect(theBed, `${id} bed`).toEqual(h.bed);

      const passable = (px: number, py: number): boolean => {
        if (px < x0 || px > x1 || py < y0 || py > y1) return false;
        const t = map.tiles[py][px];
        return t === "floor" || t === "bedTile";
      };
      const seen = new Set<string>([`${h.door.x},${h.door.y}`]);
      const queue: Vec2[] = [{ ...h.door }];
      let reached = false;
      while (queue.length > 0) {
        const c = queue.shift() as Vec2;
        if (c.x === h.bed.x && c.y === h.bed.y) {
          reached = true;
          break;
        }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = c.x + dx;
          const ny = c.y + dy;
          const k = `${nx},${ny}`;
          if (!seen.has(k) && passable(nx, ny)) {
            seen.add(k);
            queue.push({ x: nx, y: ny });
          }
        }
      }
      expect(reached, `${id} bed reachable from door`).toBe(true);

      // -- plot is all soil ---------------------------------------------------
      for (let y = h.plot.y0; y <= h.plot.y1; y++)
        for (let x = h.plot.x0; x <= h.plot.x1; x++)
          expect(at({ x, y }), `${id} plot tile ${x},${y} is soil`).toBe("soil");

      // -- footprint is STAMPED (not grass) — it really is a building now ------
      let grassInFootprint = 0;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) if (map.tiles[y][x] === "grass") grassInFootprint++;
      expect(grassInFootprint, `${id} footprint has no grass (it is stamped)`).toBe(0);
    }
  });

  it("THE PAYOFF: each activated door is strictly NEARER the tavern (A*) than the nearest corner home", () => {
    resetWorldForTests();
    const world = getWorld();
    const tavern = { ...generateMap().landmarks.find((l) => l.kind === "tavern")!.pos };

    const pathLen = (door: Vec2): number => {
      const path = world.findPath(door, tavern);
      expect(path, `A* path door ${door.x},${door.y} → tavern`).not.toBeNull();
      return path!.length;
    };

    // The 12 original corner homes (everything that is NOT an activated lot).
    const corners = HOMESTEADS.filter((h) => !ACTIVATED.includes(h.id as (typeof ACTIVATED)[number]));
    const minCorner = Math.min(...corners.map((h) => pathLen(h.door)));

    for (const id of ACTIVATED) {
      const h = HOMESTEADS.find((hh) => hh.id === id)!;
      const len = pathLen(h.door);
      expect(
        len,
        `${id} door→tavern (${len}) must be strictly < min corner (${minCorner})`,
      ).toBeLessThan(minCorner);
    }
  });

  it("the activated lot ids are absent from RESERVE_LOTS (capacity consumed)", () => {
    const lotIds = new Set(RESERVE_LOTS.map((l) => l.id));
    for (const lot of ["lot_n4", "lot_n5", "lot_n6"]) {
      expect(lotIds.has(lot), `${lot} removed from RESERVE_LOTS`).toBe(false);
    }
    // Capacity is consumed by design: 14 reserved − 3 activated = exactly 11.
    expect(RESERVE_LOTS.length, "exactly 11 reserve lots remain (14 − 3 activated)").toBe(11);
  });
});
