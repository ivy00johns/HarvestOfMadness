/**
 * Pure body-spreading geometry (Phase B-1, contracts/phase-b-body-spreading.md).
 * Teeth: lone agent → no offset; a crowd of N yields N DISTINCT offsets all
 * within radius; the helper is deterministic (same input → same output, twice);
 * sorted-by-name assignment is stable regardless of input order; offsets are
 * roughly evenly distributed (no two identical for count ≤ 8). No Phaser.
 */
import { describe, expect, it } from "vitest";
import { spreadAssignments, spreadOffset } from "../../src/obs/spread";

const RADIUS = 10;
const dist = (o: { dx: number; dy: number }): number => Math.hypot(o.dx, o.dy);
const key = (o: { dx: number; dy: number }): string => `${o.dx},${o.dy}`;

describe("spreadOffset", () => {
  it("a lone agent (count ≤ 1) gets ZERO offset", () => {
    expect(spreadOffset(0, 1, RADIUS)).toEqual({ dx: 0, dy: 0 });
    expect(spreadOffset(0, 0, RADIUS)).toEqual({ dx: 0, dy: 0 });
    // even a stray rank on a 1-set stays at center.
    expect(spreadOffset(3, 1, RADIUS)).toEqual({ dx: 0, dy: 0 });
  });

  it("count N → N distinct offsets, all within radius of center", () => {
    for (let count = 2; count <= 8; count++) {
      const offsets = Array.from({ length: count }, (_, rank) =>
        spreadOffset(rank, count, RADIUS),
      );
      // all within radius (rounding can nudge by <1px, allow a hair of slack).
      for (const o of offsets) {
        expect(dist(o)).toBeLessThanOrEqual(RADIUS + 1);
      }
      // no two members share a position (distinct bodies, not a blob).
      const uniq = new Set(offsets.map(key));
      expect(uniq.size).toBe(count);
    }
  });

  it("is deterministic — same input yields the same output twice", () => {
    for (let count = 2; count <= 12; count++) {
      for (let rank = 0; rank < count; rank++) {
        const a = spreadOffset(rank, count, RADIUS);
        const b = spreadOffset(rank, count, RADIUS);
        expect(a).toEqual(b);
      }
    }
  });

  it("dense crowds (count > 6) seat one member at the center, rest on the ring", () => {
    const count = 9;
    const offsets = Array.from({ length: count }, (_, rank) =>
      spreadOffset(rank, count, RADIUS),
    );
    // exactly one member at the center (rank 0).
    expect(offsets[0]).toEqual({ dx: 0, dy: 0 });
    const centered = offsets.filter((o) => o.dx === 0 && o.dy === 0);
    expect(centered).toHaveLength(1);
    // every non-center member sits out near the ring (clearly off-center).
    for (let rank = 1; rank < count; rank++) {
      expect(dist(offsets[rank])).toBeGreaterThan(RADIUS / 2);
    }
  });

  it("radius scales the offset; radius 0 collapses to center", () => {
    expect(spreadOffset(1, 3, 0)).toEqual({ dx: 0, dy: 0 });
    const small = spreadOffset(1, 4, 5);
    const big = spreadOffset(1, 4, 20);
    expect(dist(big)).toBeGreaterThan(dist(small));
  });
});

describe("spreadAssignments", () => {
  it("a single name → zero offset", () => {
    const m = spreadAssignments(["Solo"], RADIUS);
    expect(m.get("Solo")).toEqual({ dx: 0, dy: 0 });
    expect(m.size).toBe(1);
  });

  it("empty set → empty map", () => {
    expect(spreadAssignments([], RADIUS).size).toBe(0);
  });

  it("assigns a distinct, within-radius offset to every co-located name", () => {
    const names = ["Ana", "Bo", "Cy", "Dee", "Eve"];
    const m = spreadAssignments(names, RADIUS);
    expect(m.size).toBe(names.length);
    const seen = new Set<string>();
    for (const name of names) {
      const o = m.get(name)!;
      expect(dist(o)).toBeLessThanOrEqual(RADIUS + 1);
      seen.add(key(o));
    }
    // no two names land on the same body position.
    expect(seen.size).toBe(names.length);
  });

  it("is sorted-by-name stable — input order does not change any assignment", () => {
    const a = spreadAssignments(["Cy", "Ana", "Bo", "Dee"], RADIUS);
    const b = spreadAssignments(["Dee", "Bo", "Cy", "Ana"], RADIUS);
    for (const name of ["Ana", "Bo", "Cy", "Dee"]) {
      expect(b.get(name)).toEqual(a.get(name));
    }
    // and the rank order follows the SORTED names: Ana is rank 0.
    expect(a.get("Ana")).toEqual(spreadOffset(0, 4, RADIUS));
    expect(a.get("Bo")).toEqual(spreadOffset(1, 4, RADIUS));
    expect(a.get("Cy")).toEqual(spreadOffset(2, 4, RADIUS));
    expect(a.get("Dee")).toEqual(spreadOffset(3, 4, RADIUS));
  });

  it("is fully deterministic — same names twice yield identical maps", () => {
    const names = ["Greta", "Ivan", "Hank", "Faye"];
    const a = spreadAssignments(names, RADIUS);
    const b = spreadAssignments(names, RADIUS);
    for (const [name, o] of a) expect(b.get(name)).toEqual(o);
  });
});
