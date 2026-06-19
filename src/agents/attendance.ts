/**
 * Distance-weighted attendance policy — Phase C · Slice 1 (the single source).
 *
 * Pure, deterministic, dependency-free. No Phaser / world / Date / Math.random.
 * The "coin" is a djb2 hash of stable inputs `(name, eventId, day)` normalized to
 * `[0, 1)` via `/ 0x100000000` (precedent: `src/world/map.ts` rand2). Re-running is
 * byte-identical.
 *
 * Policy:
 *   - near agents (short home→event A* path) attend ~always,
 *   - far hamlets attend *occasionally* (never *never* — bounded by ATTEND_FLOOR),
 *   - distance is measured as the real A* tile count, computed in Cognition and
 *     handed to the mock router via the additive Observation field `homePathTiles`.
 *
 * Honest caveat: distance differentiates little on the current symmetric map —
 * all 12 homes are corner hamlets 89–99 A* tiles from the lone central tavern,
 * so attendanceProbability is uniformly ~0.505–0.555 for every real agent and
 * the per-agent COIN (not distance) selects who attends. The gradient is
 * genuinely exercised by the unit-test sweep (pathTiles 0→300+) and will start
 * to matter once nearer homesteads (reserve lots) or non-central gatherings
 * exist.
 */

/**
 * Distance (tiles) over which attendance probability decays toward the floor.
 *
 * Principle (independent of any test): at the door→tavern reach budget,
 * `attendanceProbability(REACH_BUDGET_TILES = 100) = 1 - 100/200 = 0.5` — i.e.
 * attendance is 50% at the maximum reach budget. The decay constant is chosen so
 * that "as far as an agent can still get there in a phase" maps to a coin-flip,
 * which is what fixes 200 rather than tuning-to-pass.
 *
 * Measured context (140×100 home→tavern A* lengths for all 12 party-emergence
 * personas, spanning 79–99 tiles): the dominant ~91-tile band gives
 * `attendanceProbability(91) = 1 - 91/200 = 0.545`. Across the 12 personas the
 * host (Social Sage) always attends and 6 travelers' deterministic coins clear
 * their distance-weighted probability, so 7 converge within Chebyshev ≤ 1 of the
 * tavern — comfortably above the ≥3 floor (margin ~4) — while the other 5 skip,
 * keeping attendance a strict subset ("occasionally"), not unconditional.
 */
export const ATTEND_DECAY = 200;

/**
 * Minimum attend probability for any knower, so even far hamlets attend
 * *occasionally* (never *never*). Bounds the policy from below.
 */
export const ATTEND_FLOOR = 0.05;

/**
 * The single source for the door→tavern reach budget (promoted from the
 * test-local `MAX_DOOR_TO_TAVERN_TILES`). A map-geometry reachability floor,
 * not an attendance threshold.
 */
export const REACH_BUDGET_TILES = 100;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Attendance probability as a function of the home→event A* path length (tiles).
 *
 * `clamp(1 - pathTiles / ATTEND_DECAY, ATTEND_FLOOR, 1)`. Monotonically
 * non-increasing in `pathTiles`. Guard: `pathTiles <= 0` or non-finite → `1`
 * (no / at-location distance ⇒ attend), which keeps the gate strictly additive:
 * any Observation lacking `homePathTiles` defaults to `0` ⇒ `1` ⇒ attend.
 */
export function attendanceProbability(pathTiles: number): number {
  if (!Number.isFinite(pathTiles) || pathTiles <= 0) return 1;
  return clamp(1 - pathTiles / ATTEND_DECAY, ATTEND_FLOOR, 1);
}

/**
 * djb2 — small deterministic string hash, always non-negative (`>>> 0`).
 * The repo intentionally duplicates this body per system (see `mock.ts:hash`,
 * `Governance.ts`); this is attendance's own copy.
 */
export function attendanceHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

/**
 * Deterministic attendance decision: the coin (a pure hash of `(agentName,
 * eventId, day)` normalized to `[0, 1)`) lands under the distance-weighted
 * probability. Same inputs ⇒ same boolean, always.
 */
export function willAttend(
  agentName: string,
  eventId: string,
  day: number,
  pathTiles: number,
): boolean {
  const coin = attendanceHash(`${agentName}:${eventId}:${day}`) / 0x100000000;
  return coin < attendanceProbability(pathTiles);
}
