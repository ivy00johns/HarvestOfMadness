/**
 * Body-spreading geometry — PURE (no Phaser, no RNG, no Date), so it is
 * unit-testable headlessly (Phase B-1, contracts/phase-b-body-spreading.md).
 *
 * When several agents converge on ONE logical tile (a gathering at the tavern),
 * their sprites stack into an unreadable blob. This computes a small, deterministic
 * RENDER-ONLY offset per agent so a crowd fans out around the tile center and
 * reads as distinct bodies. The offset NEVER touches sim state: `agent.pos`,
 * pathfinding and the logical grid stay byte-identical — WorldScene only nudges
 * the sprite container's rendered position by these deltas.
 *
 * Determinism is mandatory: the offset is a pure function of (a member's stable
 * rank within the co-located set, the set size). Co-located agents are ranked by
 * NAME so the same crowd always fans out the same way.
 */

/** A render-only pixel nudge from the tile center. {0,0} = no offset. */
export interface SpreadOffset {
  dx: number;
  dy: number;
}

/**
 * Fixed angular phase (radians) so a 2-member set splits along a pleasant
 * diagonal rather than dead-horizontal. Pure constant — no RNG.
 */
const PHASE = Math.PI / 6;

/**
 * Deterministic placement of member `rank` of `count` around the tile center,
 * within `radius` pixels.
 *
 * - `count <= 1` (a lone agent on the tile) → `{0, 0}` (no offset).
 * - For small crowds the members sit evenly spaced on a single ring:
 *   `angle = (rank / count) * 2π + PHASE`, so no two share an angle.
 * - For larger crowds (`count > 6`) one member sits at the CENTER and the rest
 *   fan out on the ring, which keeps a dense gathering compact without pushing
 *   anyone off their tile. The center member is always `rank 0` (stable).
 *
 * `rank` is taken modulo the effective ring size defensively so an out-of-range
 * rank still lands ON the ring rather than NaN. Offsets are always within
 * `radius` of the center (the center member is exactly at it).
 */
export function spreadOffset(rank: number, count: number, radius: number): SpreadOffset {
  if (count <= 1) return { dx: 0, dy: 0 };
  const r = Math.max(0, radius);

  // Center-plus-ring for dense crowds: rank 0 occupies the center, the remaining
  // (count - 1) members spread on the ring. Small crowds use a pure ring.
  const useCenter = count > 6;
  if (useCenter) {
    if (rank <= 0) return { dx: 0, dy: 0 };
    const ringCount = count - 1;
    const ringRank = (rank - 1) % ringCount;
    const angle = (ringRank / ringCount) * Math.PI * 2 + PHASE;
    return ringPoint(angle, r);
  }

  const idx = ((rank % count) + count) % count;
  const angle = (idx / count) * Math.PI * 2 + PHASE;
  return ringPoint(angle, r);
}

/**
 * A point on the ring of radius `r` at `angle`, rounded to whole pixels.
 * `+ 0` normalizes any `-0` (from `Math.round` of a tiny negative) to `0` so
 * offsets compare cleanly (a render delta of -0 and 0 are visually identical).
 */
function ringPoint(angle: number, r: number): SpreadOffset {
  return {
    dx: Math.round(Math.cos(angle) * r) + 0,
    dy: Math.round(Math.sin(angle) * r) + 0,
  };
}

/**
 * Assign a render-only offset to every name in a co-located set.
 *
 * Names are SORTED (localeCompare) before ranking so the assignment is stable
 * and reproducible regardless of the caller's iteration order. A single name
 * maps to `{0, 0}` (no offset). Returns a Map keyed by the original name.
 */
export function spreadAssignments(
  names: ReadonlyArray<string>,
  radius: number,
): Map<string, SpreadOffset> {
  const out = new Map<string, SpreadOffset>();
  if (names.length === 0) return out;
  if (names.length === 1) {
    out.set(names[0], { dx: 0, dy: 0 });
    return out;
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const count = sorted.length;
  for (let rank = 0; rank < count; rank++) {
    out.set(sorted[rank], spreadOffset(rank, count, radius));
  }
  return out;
}
