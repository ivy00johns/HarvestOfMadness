/**
 * Phase C · Slice 1 — distance-weighted attendance policy proof.
 *
 * Proves the PURE policy in `src/agents/attendance.ts`:
 *   - attendanceProbability: 0 → 1; monotonic non-increasing; floors at
 *     ATTEND_FLOOR past ATTEND_DECAY; always within [FLOOR, 1].
 *   - willAttend: deterministic; near → ~all attend; far → strict subset
 *     ("occasionally"); replay-identical; host-always-attends (callers gate the
 *     host out separately, but distance never forces a near agent to skip).
 */

import { describe, expect, it } from "vitest";
import {
  ATTEND_DECAY,
  ATTEND_FLOOR,
  attendanceProbability,
  willAttend,
} from "../../src/agents/attendance";

const AGENTS = [
  "Diligent Dora",
  "Reckless Rusty",
  "Social Sage",
  "Grumbling Gus",
  "Frugal Fern",
  "Tinkering Brix",
  "Nervous Nell",
  "Wandering Wren",
  "Salty Ford",
  "Stern Clem",
  "Mossy Bram",
  "Proud Zola",
];
const EVENT_IDS = ["party-d2", "feast-d3", "bonfire-d5", "wedding-d7"];
const DAYS = [1, 2, 3, 4, 5, 6, 7];

describe("attendanceProbability", () => {
  it("pathTiles = 0 → 1 (at-location ⇒ attend)", () => {
    expect(attendanceProbability(0)).toBe(1);
  });

  it("non-finite / negative pathTiles → 1 (additive default)", () => {
    expect(attendanceProbability(-5)).toBe(1);
    expect(attendanceProbability(NaN)).toBe(1);
    expect(attendanceProbability(Infinity)).toBe(1);
  });

  it("is monotonic non-increasing in pathTiles", () => {
    let prev = attendanceProbability(0);
    for (let d = 1; d <= 300; d++) {
      const p = attendanceProbability(d);
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
  });

  it("floors at ATTEND_FLOOR once pathTiles ≥ ATTEND_DECAY", () => {
    expect(attendanceProbability(ATTEND_DECAY)).toBeCloseTo(ATTEND_FLOOR, 10);
    expect(attendanceProbability(ATTEND_DECAY + 50)).toBe(ATTEND_FLOOR);
    expect(attendanceProbability(10_000)).toBe(ATTEND_FLOOR);
  });

  it("is always within [ATTEND_FLOOR, 1]", () => {
    for (let d = 0; d <= 500; d++) {
      const p = attendanceProbability(d);
      expect(p).toBeGreaterThanOrEqual(ATTEND_FLOOR);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe("willAttend", () => {
  it("is deterministic (same inputs → same boolean, repeated)", () => {
    for (const name of AGENTS) {
      const a = willAttend(name, "party-d2", 2, 91);
      for (let i = 0; i < 5; i++) {
        expect(willAttend(name, "party-d2", 2, 91)).toBe(a);
      }
    }
  });

  it("near (small pathTiles) → ~all agents attend", () => {
    let attended = 0;
    let total = 0;
    for (const name of AGENTS) {
      for (const eid of EVENT_IDS) {
        for (const day of DAYS) {
          total++;
          if (willAttend(name, eid, day, 3)) attended++;
        }
      }
    }
    // pathTiles = 3 ⇒ probability ≈ 0.985, so the overwhelming majority attend.
    expect(attended / total).toBeGreaterThan(0.9);
  });

  it("far (large pathTiles) → a strict subset attend (occasionally)", () => {
    // Far past ATTEND_DECAY ⇒ probability floors at ATTEND_FLOOR. Across the full
    // sweep some coins still land under the floor (occasionally), but it is a
    // strict subset: count strictly between 0 and N.
    let attended = 0;
    let total = 0;
    for (const name of AGENTS) {
      for (const eid of EVENT_IDS) {
        for (const day of DAYS) {
          total++;
          if (willAttend(name, eid, day, ATTEND_DECAY + 100)) attended++;
        }
      }
    }
    expect(attended).toBeGreaterThan(0);
    expect(attended).toBeLessThan(total);
  });

  it("replay identity: computing the attendance set twice is identical", () => {
    const compute = () => {
      const set: string[] = [];
      for (const name of AGENTS) {
        for (const eid of EVENT_IDS) {
          for (const day of DAYS) {
            if (willAttend(name, eid, day, 91)) set.push(`${name}|${eid}|${day}`);
          }
        }
      }
      return set;
    };
    expect(compute()).toEqual(compute());
  });

  it("host always attends regardless of distance (caller gate), and near distance never forces a skip", () => {
    // The host exemption lives in the caller (mock.ts) — distance alone must not
    // make a near agent skip. At pathTiles = 0 the probability is 1, so EVERY
    // (agent, event, day) combination attends, which is what the host path relies
    // on when homePathTiles is absent (defaults to 0).
    for (const name of AGENTS) {
      for (const eid of EVENT_IDS) {
        for (const day of DAYS) {
          expect(willAttend(name, eid, day, 0)).toBe(true);
        }
      }
    }
  });
});
