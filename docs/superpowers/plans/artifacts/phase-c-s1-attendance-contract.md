# Contract — Phase C · Slice 1: Distance-weighted attendance

**Branch:** `feat/phase-c-distance-attendance`
**Goal (North Star §5 / §3 Option C step 2):** Replace the current
"every agent who *knows* about a seeded gathering walks to it unconditionally"
with **deterministic, distance-weighted, occasional** attendance — near agents
attend ~always, far hamlets attend *sometimes*, the host always — without
breaking determinism or any party-emergence invariant. "Behind the mock/live
split" = the logic lives in the deterministic `mockRouter`; `liveRouter` is
untouched. Sim mechanics stay deterministic in **both** modes.

## Why this shape (from the understand-workflow map)

- The only attendance gate today is knowledge diffusion + `isNow`. The mock
  ATTEND branch (`src/llm/mock.ts:407-424`) is **unconditional**: any agent with
  an `isNow` known event `moveTo`s `nowEvent.location`. Distance is never consulted.
- Real A* path length is only reachable from `Cognition` (it holds `this.world()`);
  `mock.ts` is a **pure function of the Observation** and has no `world` handle.
  So the home→event distance must be computed in `Cognition.enrichObservation`
  and passed to mock via an **additive optional Observation field**.
- The blessed deterministic "coin" is djb2 `hash(stableKey) >>> 0`, normalized to
  `[0,1)` by `/ 0x100000000` (precedent: `src/world/map.ts:478` `rand2`). **Zero
  `Math.random`, zero `Date`.** Seed on stable inputs `(name, eventId, day)` only.

## Files & changes

### 1. NEW `src/agents/attendance.ts` (pure, the single source of policy)
- `export const ATTEND_DECAY: number` — distance (tiles) over which attendance
  probability decays toward the floor.
- `export const ATTEND_FLOOR: number` — minimum attend probability for any knower
  (so even far hamlets attend *occasionally*, never *never*).
- `export const REACH_BUDGET_TILES = 100` — the single source for the door→tavern
  reach budget (promoted from the test-local `MAX_DOOR_TO_TAVERN_TILES`).
- `export function attendanceProbability(pathTiles: number): number`
  `= clamp(1 - pathTiles / ATTEND_DECAY, ATTEND_FLOOR, 1)`.
  Guard: `pathTiles <= 0` or non-finite → `1` (no/at-location distance ⇒ attend).
- `export function attendanceHash(s: string): number` — djb2, returns `>>> 0`
  (copy the repo's existing djb2 body; the repo intentionally duplicates it per
  system — see `mock.ts:311`, `Governance.ts:42`).
- `export function willAttend(agentName: string, eventId: string, day: number, pathTiles: number): boolean`
  `= attendanceHash(\`${agentName}:${eventId}:${day}\`) / 0x100000000 < attendanceProbability(pathTiles)`.
- 100% pure. No imports of Phaser/world/Date/Math.random.

### 2. `src/agents/Agent.ts`
- Add `readonly home: Vec2;` set in the constructor from `p.start` (the homestead
  door anchor — today only copied into `pos` then discarded). Additive, harmless.

### 3. `contracts/types.ts`
- Extend the `knownEvents` entry type (line 215) from
  `(SimEvent & { isNow: boolean })[]`
  to `(SimEvent & { isNow: boolean; homePathTiles?: number })[]`.
  **Optional + additive** — absent on every synthetic Observation, so existing
  callers and wire/redact/conformance tests are unaffected.

### 4. `src/agents/Cognition.ts` — `enrichObservation` (the `knownEvents` map, ~1174-1183)
- For each known event with `isNow === true`, compute
  `homePathTiles = this.world().findPath(agent.home, e.location)?.length`
  and attach it to that entry (`{ ...e, isNow, homePathTiles }`). Non-`isNow`
  events don't need it (mock only reads it on `nowEvent`).
- **Memoize** by `(homeKey, locationKey)` on a per-system `Map` so A* runs at most
  once per (home, location) pair, not every decision (A* over a 140×100 grid with a
  linear-scan open list is costly; homes + tavern are static, so the table is tiny
  and deterministic). `findPath` returning `null` (shouldn't happen — reachability
  invariant guarantees ≤100) → omit the field (mock defaults to attend) or set a
  large value; pick one and be explicit.

### 5. `src/llm/mock.ts` — the ATTEND branch (`if (nowEvent)`, ~407-424)
- **Keep the already-adjacent EMOTE/WAIT path UNGATED** — agents already at the
  tavern (incl. the host, who seeds there) keep celebrating. This alone preserves
  `event_arrived ≥ 1`.
- Gate **only the traveler `moveTo`**: compute
  `const attend = nowEvent.host === self.name
       || willAttend(self.name, nowEvent.id, obs.time.day, nowEvent.homePathTiles ?? 0);`
  - `nowEvent.homePathTiles ?? 0` → `attendanceProbability(0) = 1` → attend, so any
    Observation without the field (mock-determinism synthetic obs, kill-switch path)
    is **byte-identical to today**.
  - **Host exemption:** the host never skips their own party.
  - If `attend === false`: do **not** `moveTo` the event this decision — fall
    through to the normal (dispersive) ladder below (farm/social/etc.). The far
    agent simply does its own thing this phase; on a different `(eventId, day)` its
    coin may land differently ⇒ "occasionally".

## Determinism & invariants — MUST hold (tests are the source of truth)

- **Zero `Math.random`, zero `Date`.** Coin = pure hash of `(name, eventId, day)`.
- `node_modules/vitest/vitest.mjs run` stays green (currently 1121 tests). Specifically:
  - **party-emergence positive** (`tests/agents/party-emergence.test.ts`, ~198-229):
    `knowerCount ≥ 4`, `≥ 3` agents within Chebyshev ≤ 1 of the tavern, and
    `≥ 1 event_arrived`. **MUST stay green.** TDD-converge `ATTEND_DECAY`/`ATTEND_FLOOR`
    so the host (already at tavern) plus enough near travelers clear the gate to keep
    `≥ 3`. The host + ungated EMOTE/WAIT guarantees the arrival.
  - **party-emergence kill-switch** (~240-254): no seed ⇒ no `nowEvent` ⇒ the gate
    never runs ⇒ byte-identical.
  - **party-emergence reachability** (~259-288): A* door→tavern ≤ 100. Do **not**
    touch `generateMap`/`findPath`. Update the test to import `REACH_BUDGET_TILES`
    from `src/agents/attendance.ts` (single source) — asserted value stays `100`.
  - **mock-determinism** (`tests/qe/mock-determinism.test.ts`): byte-identical replay
    across 50 calls / interleaved / 2×10-day passes. Synthetic obs lack `homePathTiles`
    ⇒ default attend ⇒ unchanged.
  - **map.test** decor zero-RNG and **contract-conformance / wire-redact**: the new
    field is optional/additive — verify still green; update only if they enumerate
    Observation fields exhaustively.
- `node_modules/typescript/bin/tsc --noEmit` clean.
- No new magic numbers outside `src/agents/attendance.ts` (constants single-sourced).

## NEW test — `tests/qe/attendance-distance.test.ts`
- `attendanceProbability`: `pathTiles = 0 → 1`; monotonic **non-increasing** in
  `pathTiles`; `pathTiles ≥ ATTEND_DECAY → ATTEND_FLOOR`; always within `[FLOOR, 1]`.
- `willAttend`: deterministic (same inputs → same bool, repeated); **near**
  (small `pathTiles`) → `true` for ~all agents; **far** (large `pathTiles`) →
  a **strict subset** of `(agent, eventId, day)` combos attend (proves "occasionally":
  count strictly between 0 and N) across a sweep of eventIds/days.
- **Replay identity:** computing the attendance set twice yields identical results.
- **Host always attends** regardless of distance.

## Out of scope (this slice)
- Live-mode behavioral changes (sim stays deterministic in both modes).
- Generalizing to non-tavern gatherings beyond what `e.location` already gives for free.
- Distance-weighting for the cafe/office/store/park role-visits (separate behavior).
- North Star doc update + commit — the orchestrator does these after the gate.
