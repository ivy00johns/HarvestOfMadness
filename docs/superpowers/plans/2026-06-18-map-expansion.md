# Map Expansion (World Dressing — Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the town from 64×40 to 96×64, spread the 12 occupied homesteads into roomier districts, and reserve ~13 road-connected lots for future homes — fully isolated from the governance session, with every existing test green.

**Architecture:** A pure-data re-layout of `src/world/map.ts`, a 2-constant dimension bump in `@contracts/types`, and camera tuning in `src/config.ts`. The renderer adapts automatically because it reads `MAP_WIDTH`/`MAP_HEIGHT`/`TILE_SIZE`. Correctness is driven by the existing **coordinate-agnostic** `tests/world/map.test.ts` (structure, counts, connectivity, observation range) plus the agents-layer reachability gate (`tests/agents/party-emergence.test.ts`).

**Tech Stack:** TypeScript, Vitest, deterministic (zero-RNG, zero-`Date`) generative map.

---

## Context & Hard Gates

This is **Phase 1** of the spec `docs/superpowers/specs/2026-06-17-world-dressing-design.md`. Work happens in the worktree `/Users/johns/Projects/HOM-world-dressing` on branch `feat/world-dressing`.

**Node invocation (known nvm issue — see project memory):** the `node`/`npm` zsh functions shadow the binaries. Every command that runs node MUST be prefixed:
```bash
N="$HOME/.nvm/versions/node/v22.22.3/bin"; unfunction node npm npx nvm 2>/dev/null; unset -f node npm npx nvm 2>/dev/null; export PATH="$N:$PATH"
```
Then run vitest via: `"$N/node" "$N/../lib/node_modules/npm/bin/npm-cli.js" test -- <args>`.
For brevity below, `RUN_TESTS <path>` means: apply that prefix, then `"$N/node" node_modules/vitest/vitest.mjs run <path>`.

**Isolation — files this plan may touch:**
- `contracts/types.ts` — ONLY the two integer constants `MAP_WIDTH`, `MAP_HEIGHT` (lines 127–128). This is the single file shared with the governance session; the edit is two numbers on existing lines, so the merge is trivial (governance appends new types elsewhere). Touch nothing else in this file.
- `src/world/map.ts` — the layout tables and generator.
- `src/config.ts` — camera comments/constants referencing the old 64×40 size.
- `tests/world/map.test.ts` — add the reserve-lot test (existing assertions stay as-is).
- `tests/world/reserve-lots.test.ts` — new.

**Do NOT edit** `src/agents/*`, `tests/agents/*`, `src/scenes/*`, `src/obs/*`, or `contracts/*` beyond the two constants. You MUST still **run** the full suite so agents-layer tests stay green.

**Hard gates (every task must keep these true):**
1. `HOMESTEADS.length === 12`; 12 `bedTile`s; landmark counts `bed=12, house=12, shop=1, tavern=1, cafe=1, office=1, park=1`; `BUILDINGS.length === 17`.
2. Persona ids unchanged: `brix, ford, wren, dora, gus, clem` (north intent) and `fern, nell, sage, rusty, moss, zola` (south intent). `HOMESTEAD_DOORS` keeps all 12 keys (consumed by `src/agents/personas.ts`).
3. Every homestead door reaches the tavern in **≤ 40 A\* tiles** (`party-emergence.test.ts`). Reserve lots must satisfy the same bound so they are drop-in ready.
4. Each homestead plot's nearest cell is within **Chebyshev 4** (`OBSERVATION_RADIUS`) of its door.
5. Road-first invariant: every door-gap's exterior neighbour is a `path` tile; every door/bed/shop reachable from the tavern via passable tiles.
6. Determinism: no `Math.random`, no `Date`. Re-running `generateMap()` yields the identical map.

**Layout target (96×64).** Downtown civic core dead-centre so the ≤40 bound is comfortable; two residential roads (north `y=14`, south `y=54`) with the spine at `y=36`; a park with pond to the east; the outer rim left as open countryside for the later foliage/scatter phases.

```
            x=0 ............................................. x=95
 y=0   ┌──────────────────────── wall ring ───────────────────────┐
 y=14  │  ── north residential road (homes above, doors face S) ── │
 y=30  │            shop   TAVERN   cafe   (civic core)            │
 y=34  │            ── plaza row (y=35) → spine joiners ──         │   PARK
 y=36  │  ═══════════════ main spine (y=36) ═══════════════════    │  + pond
 y=40  │            office        school                           │  (east)
 y=54  │  ── south residential road (homes below, doors face N) ── │
 y=63  └───────────────────────────────────────────────────────────┘
        verticals tie north road ↔ spine ↔ south road at x=8,24,48,72,88
```

---

## File Structure

- `contracts/types.ts` — map dimensions (2 constants). No structural change.
- `src/world/map.ts` — re-authored `HOMESTEADS`, `ROAD_SEGMENTS`, `COMMONS`, `PARK`/`POND`, world-object positions; **new** `RESERVE_LOTS` export + `ReserveLot` type. Single responsibility unchanged (deterministic town generator).
- `src/config.ts` — camera zoom/pan constants + the comment strings that hardcode "64×40".
- `tests/world/map.test.ts` — unchanged assertions (they're structural).
- `tests/world/reserve-lots.test.ts` — new: reserve-lot reachability/clearance + count.

---

## Task 1: Bump map dimensions and retune the camera

**Files:**
- Modify: `contracts/types.ts:127-128`
- Modify: `src/config.ts` (DEFAULT_ZOOM/CAMERA_ZOOM_MIN/CAMERA_PAN_SPEED + their doc comments)

This step alone keeps the suite green: the existing rooms/roads all sit at coords < 64×40, which remain valid inside 96×64. The town will look crammed into the NW corner of a big empty field — that is the expected, test-green intermediate we commit before re-laying-out.

- [ ] **Step 1: Run the suite to confirm the green baseline**

`RUN_TESTS tests/world/map.test.ts tests/agents/party-emergence.test.ts`
Expected: PASS (baseline before any change).

- [ ] **Step 2: Bump the dimension constants**

In `contracts/types.ts`, change ONLY these two lines:
```ts
export const MAP_WIDTH = 96;   // was 64
export const MAP_HEIGHT = 64;  // was 40
```
Leave `TILE_SIZE = 32` and `OBSERVATION_RADIUS = 4` untouched.

- [ ] **Step 3: Retune the camera in `src/config.ts`**

Replace the `DEFAULT_ZOOM`, `CAMERA_ZOOM_MIN`, and `CAMERA_PAN_SPEED` declarations (and their doc comments that say "64×40 / 2048×1280") with values fit for 96×64 (3072×2048 world px):
```ts
/** Default spectator zoom for the 96×64 town (3072×2048 world px). ~24 tiles
 *  across a typical 1440-wide viewport at 1.5. */
export const DEFAULT_ZOOM = 1.5;
/** @deprecated prefer DEFAULT_ZOOM */
export const GAME_ZOOM = DEFAULT_ZOOM;
/** Fit-to-map lower clamp for the larger 96×64 world on typical viewports. */
export const CAMERA_ZOOM_MIN = 0.4;
export const CAMERA_ZOOM_MAX = 3;
```
And update `CAMERA_PAN_SPEED`'s comment to reference the 96×64 map (keep the value 720, or raise to 960 so panning the wider map stays ~3s at zoom 1):
```ts
/** Keyboard pan speed (world px/sec at zoom 1, scaled by 1/zoom). Raised for
 *  the 96×64 map so a full-width pan still takes a comfortable ~3s at zoom 1. */
export const CAMERA_PAN_SPEED = 960;
```

- [ ] **Step 4: Run the full suite — everything must still pass**

`RUN_TESTS` (no path = whole suite) — i.e. `"$N/node" node_modules/vitest/vitest.mjs run`
Expected: PASS (933 tests). The map test's wall-ring/count/connectivity assertions hold because they read `MAP_WIDTH`/`MAP_HEIGHT`; the spine auto-extends (`x1: MAP_WIDTH - 2`); homesteads/tavern are unchanged so the ≤40 gate holds.

- [ ] **Step 5: Commit**

```bash
git add contracts/types.ts src/config.ts
git commit -m "feat: enlarge town canvas to 96x64

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Re-author the road network for 96×64

**Files:** Modify `src/world/map.ts` (`SPINE_Y`, `ROAD_SEGMENTS`)

Lay the road grid FIRST (the generator stamps roads before rooms). The grid below gives a central downtown, two residential roads, a park spur, and verticals — sized so Tasks 3–5 can hang ≤25 homes off it within the ≤40 bound.

- [ ] **Step 1: Replace `SPINE_Y` and `ROAD_SEGMENTS`**

```ts
const SPINE_Y = 36;

export const ROAD_SEGMENTS: RoadSeg[] = [
  // main horizontal connector spine across the interior
  { x0: 1, y0: SPINE_Y, x1: MAP_WIDTH - 2, y1: SPINE_Y },
  // north residential road (homes above face S onto y=14)
  { x0: 4, y0: 14, x1: 92, y1: 14 },
  // south residential road (homes below face N onto y=54)
  { x0: 4, y0: 54, x1: 92, y1: 54 },
  // vertical trunks tying both residential rows to the spine
  { x0: 8,  y0: 14, x1: 8,  y1: 54 },
  { x0: 24, y0: 14, x1: 24, y1: 54 },
  { x0: 48, y0: 14, x1: 48, y1: 54 },
  { x0: 72, y0: 14, x1: 72, y1: 54 },
  { x0: 88, y0: 14, x1: 88, y1: 54 },
  // downtown plaza row (civic door exteriors), one above the spine
  { x0: 34, y0: 35, x1: 58, y1: 35 },
  { x0: 36, y0: 35, x1: 36, y1: 36 }, // shop column joiner to spine
  { x0: 47, y0: 35, x1: 47, y1: 36 }, // tavern column joiner to spine
  { x0: 56, y0: 35, x1: 56, y1: 36 }, // cafe column joiner to spine
  // park access spur (east): drop from the spine up to the park's south edge
  { x0: 78, y0: 24, x1: 78, y1: 36 },
];
```

- [ ] **Step 2: Run the map test (connectivity will fail until rooms move, that's expected for the per-room asserts; the wall-ring + decor asserts should still pass)**

`RUN_TESTS tests/world/map.test.ts`
Expected: the road-only change keeps grass/wall/decor green; per-homestead and per-building asserts may fail because rooms still sit at old coords off the new grid. Proceed to Task 3 (do NOT commit a red state — Tasks 2–4 land together in Task 4's commit).

---

## Task 3: Re-lay the 12 occupied homesteads onto the new grid

**Files:** Modify `src/world/map.ts` (`HOMESTEADS`)

Six homesteads hang off the north road (`y=14`, doors face S, house bottom row `y=13`), six off the south road (`y=54`, doors face N, house top row `y=55`). Persona ids and the north/south intent are preserved. Each plot sits on an open side within Chebyshev 4 of the door. These coordinates are the **designed starting point** — the TDD loop in Step 2 converges any that miss a gate.

- [ ] **Step 1: Replace the `HOMESTEADS` array**

North band (house occupies rows `y0..13`, door at `(doorX,13)`, exterior `(doorX,14)` = north road):
```ts
export const HOMESTEADS: HomesteadSpec[] = [
  // -- north band: doors face S onto the y=14 road -------------------------
  { id: "brix", house: { x: 6,  y: 9 },  size: { w: 5, h: 5 }, bed: { x: 8,  y: 11 }, door: { x: 8,  y: 13 }, doorSide: "S", plot: { x0: 11, y0: 11, x1: 13, y1: 13 } },
  { id: "ford", house: { x: 18, y: 9 },  size: { w: 6, h: 5 }, bed: { x: 20, y: 11 }, door: { x: 20, y: 13 }, doorSide: "S", plot: { x0: 15, y0: 11, x1: 17, y1: 13 } },
  { id: "wren", house: { x: 30, y: 10 }, size: { w: 4, h: 4 }, bed: { x: 31, y: 11 }, door: { x: 31, y: 13 }, doorSide: "S", plot: { x0: 34, y0: 11, x1: 36, y1: 13 } },
  { id: "dora", house: { x: 60, y: 9 },  size: { w: 5, h: 5 }, bed: { x: 62, y: 11 }, door: { x: 62, y: 13 }, doorSide: "S", plot: { x0: 56, y0: 11, x1: 58, y1: 13 } },
  { id: "gus",  house: { x: 70, y: 9 },  size: { w: 6, h: 5 }, bed: { x: 72, y: 11 }, door: { x: 72, y: 13 }, doorSide: "S", plot: { x0: 76, y0: 11, x1: 78, y1: 13 } },
  { id: "clem", house: { x: 84, y: 10 }, size: { w: 4, h: 4 }, bed: { x: 85, y: 11 }, door: { x: 85, y: 13 }, doorSide: "S", plot: { x0: 80, y0: 11, x1: 82, y1: 13 } },
  // -- south band: doors face N onto the y=54 road; house top row y=55 ------
  { id: "fern",  house: { x: 6,  y: 55 }, size: { w: 5, h: 5 }, bed: { x: 8,  y: 57 }, door: { x: 8,  y: 55 }, doorSide: "N", plot: { x0: 11, y0: 55, x1: 13, y1: 57 } },
  { id: "nell",  house: { x: 18, y: 55 }, size: { w: 4, h: 4 }, bed: { x: 19, y: 56 }, door: { x: 19, y: 55 }, doorSide: "N", plot: { x0: 22, y0: 55, x1: 24, y1: 57 } },
  { id: "sage",  house: { x: 42, y: 55 }, size: { w: 6, h: 5 }, bed: { x: 44, y: 57 }, door: { x: 44, y: 55 }, doorSide: "N", plot: { x0: 37, y0: 55, x1: 39, y1: 57 } },
  { id: "rusty", house: { x: 60, y: 55 }, size: { w: 5, h: 5 }, bed: { x: 62, y: 57 }, door: { x: 62, y: 55 }, doorSide: "N", plot: { x0: 56, y0: 55, x1: 58, y1: 57 } },
  { id: "moss",  house: { x: 70, y: 55 }, size: { w: 4, h: 4 }, bed: { x: 71, y: 56 }, door: { x: 71, y: 55 }, doorSide: "N", plot: { x0: 74, y0: 55, x1: 76, y1: 57 } },
  { id: "zola",  house: { x: 82, y: 55 }, size: { w: 6, h: 5 }, bed: { x: 84, y: 57 }, door: { x: 84, y: 55 }, doorSide: "N", plot: { x0: 77, y0: 55, x1: 79, y1: 57 } },
];
```

- [ ] **Step 2: TDD-converge against the gates**

`RUN_TESTS tests/world/map.test.ts tests/agents/party-emergence.test.ts`

For each failure, adjust the offending homestead's coordinates and re-run:
- "perimeter wall/floor (door) count" / "door exterior is a road path" → the door must be on the room's perimeter row/col and its exterior neighbour must be a road tile (north door `y=13` → `(x,14)` must be on the `y=14` road, i.e. `4 ≤ x ≤ 92`).
- "plot within OBSERVATION_RADIUS of its door" → move the plot so its nearest cell is Chebyshev ≤ 4 from the door.
- "plot tile is soil" / overlaps → ensure plots don't overlap a house, road, or another plot.
- "door→tavern path exceeds 40 tiles" → move the homestead closer to a vertical trunk / the spine (all six per band are within ~30 A\* of a central tavern with this grid; the far-east `clem`/`zola` rely on the `x=88` trunk).

Iterate until BOTH files are fully green.

---

## Task 4: Re-place downtown, park, pond, world objects, and trees; commit Tasks 2–4

**Files:** Modify `src/world/map.ts` (`COMMONS`, `PARK`, `POND`, `WELL_POS`, `NOTICE_BOARD_POS`, `BENCH_POS`, `PARK_BENCH_POS`, `TREE_SPOTS` if present in map.ts — note `TREE_SPOTS` lives in `WorldScene.ts` and is out of scope; only the map-side `decor` scatter is here)

- [ ] **Step 1: Replace `COMMONS` (civic core, doors drop onto the plaza/spine)**

```ts
const COMMONS: CommonsSpec[] = [
  // Tavern: 7×5, dead-centre above the spine; door S onto plaza row y=35.
  { kind: "tavern", rect: { x0: 44, y0: 30, x1: 50, y1: 34 }, door: { x: 47, y: 34 }, doorSide: "S" },
  // Shop: 5×5, west of tavern; door S onto plaza; shopTile centre interior.
  { kind: "shop", rect: { x0: 34, y0: 30, x1: 38, y1: 34 }, door: { x: 36, y: 34 }, doorSide: "S", specialTile: { x: 36, y: 32 } },
  // Cafe: 5×4, east of tavern; door S onto plaza.
  { kind: "cafe", rect: { x0: 54, y0: 31, x1: 58, y1: 34 }, door: { x: 56, y: 34 }, doorSide: "S" },
  // Office: 5×5, below the spine; door N onto the spine (exterior y=36).
  { kind: "office", rect: { x0: 40, y0: 37, x1: 44, y1: 41 }, door: { x: 42, y: 37 }, doorSide: "N" },
  // School: 6×5, below-right of the spine; door N onto the spine.
  { kind: "school", rect: { x0: 50, y0: 37, x1: 55, y1: 41 }, door: { x: 52, y: 37 }, doorSide: "N" },
];
```

- [ ] **Step 2: Re-place the park, pond, world objects to the east region**

```ts
export const PARK = { x0: 74, y0: 24, x1: 84, y1: 34 };
const POND = { x0: 77, y0: 27, x1: 81, y1: 30 }; // ≥4-wide, grass border inside park

export const WELL_POS: Vec2 = { x: 41, y: 35 };         // plaza row, west of tavern
export const NOTICE_BOARD_POS: Vec2 = { x: 42, y: 35 }; // well + (1,0)
export const BENCH_POS: Vec2 = { x: 75, y: 28 };        // park grass, west of pond
const PARK_BENCH_POS: Vec2 = { x: 83, y: 28 };          // park grass, east of pond
```
The park's south edge (`y=34`) sits one tile above the spine path that the `x=78` park spur joins, so the whole park region stays BFS-connected. Confirm `WELL_POS`/`NOTICE_BOARD_POS` land on the plaza `path` row (`y=35`).

- [ ] **Step 3: Confirm the decor scatter still seeds the park**

The `parkTree` guard uses `{ x: PARK.x0, y: PARK.y0 + 1 }` — verify that cell is grass (not pond/bench). With `PARK.x0=74, y=25` it is grass. The decor cap stays at 16 for this phase (foliage density is Phase 5).

- [ ] **Step 4: Full suite green, then commit Tasks 2–4**

`RUN_TESTS` (whole suite)
Expected: PASS (933). If `map.test.ts` "park has ≥1 bench/tree inside" fails, nudge bench/tree coords into the park rect.

```bash
git add src/world/map.ts
git commit -m "feat: re-lay the town across the 96x64 canvas

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Reserve ~13 road-connected lots for future homesteads

**Files:**
- Modify: `src/world/map.ts` (add `ReserveLot` type + `RESERVE_LOTS` export)
- Create: `tests/world/reserve-lots.test.ts`

A reserve lot is a documented, road-adjacent grass footprint where the agents session can later drop a homestead + persona with zero re-survey. Lots change NO tiles (stay grass), add NO landmarks, and bind NO persona — so all Task-1..4 gates are untouched.

- [ ] **Step 1: Write the failing test**

Create `tests/world/reserve-lots.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { TileType, Vec2 } from "@contracts/types";
import { MAP_WIDTH, MAP_HEIGHT, OBSERVATION_RADIUS } from "@contracts/types";
import { generateMap, RESERVE_LOTS, exteriorOf } from "../../src/world/map";

const map = generateMap();
const at = (p: Vec2): TileType => map.tiles[p.y][p.x];

describe("reserve lots (future-homestead capacity)", () => {
  it("reserves at least 13 lots", () => {
    expect(RESERVE_LOTS.length).toBeGreaterThanOrEqual(13);
  });

  it("each lot is clear grass, in bounds, with a road-adjacent door and an in-range plot", () => {
    for (const lot of RESERVE_LOTS) {
      // footprint + plot are entirely grass (nothing stamped yet)
      for (let y = lot.house.y0; y <= lot.house.y1; y++)
        for (let x = lot.house.x0; x <= lot.house.x1; x++)
          expect(at({ x, y }), `lot ${lot.id} house tile ${x},${y}`).toBe("grass");
      for (let y = lot.plot.y0; y <= lot.plot.y1; y++)
        for (let x = lot.plot.x0; x <= lot.plot.x1; x++)
          expect(at({ x, y }), `lot ${lot.id} plot tile ${x},${y}`).toBe("grass");
      // bounds
      expect(lot.house.x0).toBeGreaterThan(0);
      expect(lot.house.y0).toBeGreaterThan(0);
      expect(lot.house.x1).toBeLessThan(MAP_WIDTH - 1);
      expect(lot.house.y1).toBeLessThan(MAP_HEIGHT - 1);
      // door's exterior neighbour is a road, so activation is drop-in
      expect(at(exteriorOf(lot.door, lot.doorSide)), `lot ${lot.id} door faces a road`).toBe("path");
      // plot within observation range of the door
      const cheb = (a: Vec2, b: Vec2) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      let nearest = Infinity;
      for (let y = lot.plot.y0; y <= lot.plot.y1; y++)
        for (let x = lot.plot.x0; x <= lot.plot.x1; x++)
          nearest = Math.min(nearest, cheb(lot.door, { x, y }));
      expect(nearest, `lot ${lot.id} plot in range`).toBeLessThanOrEqual(OBSERVATION_RADIUS);
    }
  });

  it("lots do not overlap any built room or another lot", () => {
    const occupied = new Set<string>();
    for (let y = 0; y < MAP_HEIGHT; y++)
      for (let x = 0; x < MAP_WIDTH; x++)
        if (map.tiles[y][x] !== "grass") occupied.add(`${x},${y}`);
    const claimed = new Set<string>();
    for (const lot of RESERVE_LOTS) {
      for (let y = lot.house.y0; y <= lot.house.y1; y++)
        for (let x = lot.house.x0; x <= lot.house.x1; x++) {
          const k = `${x},${y}`;
          expect(occupied.has(k), `lot ${lot.id} overlaps a built tile at ${k}`).toBe(false);
          expect(claimed.has(k), `lot ${lot.id} overlaps another lot at ${k}`).toBe(false);
          claimed.add(k);
        }
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

`RUN_TESTS tests/world/reserve-lots.test.ts`
Expected: FAIL — `RESERVE_LOTS` / `ReserveLot` not exported from `map.ts`.

- [ ] **Step 3: Add the `ReserveLot` type and `RESERVE_LOTS` export in `map.ts`**

Place near `HOMESTEADS` (these are pure data; nothing stamps them). Coordinates hang off the same north/south roads in the gaps between occupied homes, plus the inner sides of the residential rows. Starting set (TDD-converge in Step 4):
```ts
/** A reserved, road-adjacent grass footprint for a FUTURE homestead. Stamps no
 *  tiles, adds no landmark, binds no persona — pure capacity the agents layer
 *  can later activate (add a persona + promote to HOMESTEADS) with no re-survey. */
export interface ReserveLot {
  id: string;
  house: { x0: number; y0: number; x1: number; y1: number };
  bed: Vec2;
  door: Vec2;
  doorSide: DoorSide;
  plot: { x0: number; y0: number; x1: number; y1: number };
}

export const RESERVE_LOTS: ReserveLot[] = [
  // north-road gaps (doors face S onto y=14; house bottom row y=13)
  { id: "lot_n1", house: { x0: 38, y0: 9, x1: 42, y1: 13 }, bed: { x: 40, y: 11 }, door: { x: 40, y: 13 }, doorSide: "S", plot: { x0: 43, y0: 11, x1: 45, y1: 13 } },
  { id: "lot_n2", house: { x0: 48, y0: 9, x1: 52, y1: 13 }, bed: { x: 50, y: 11 }, door: { x: 50, y: 13 }, doorSide: "S", plot: { x0: 44, y0: 11, x1: 46, y1: 13 } },
  { id: "lot_n3", house: { x0: 12, y0: 17, x1: 16, y1: 21 }, bed: { x: 14, y: 19 }, door: { x: 14, y: 17 }, doorSide: "N", plot: { x0: 17, y0: 18, x1: 19, y1: 20 } },
  { id: "lot_n4", house: { x0: 28, y0: 17, x1: 32, y1: 21 }, bed: { x: 30, y: 19 }, door: { x: 30, y: 17 }, doorSide: "N", plot: { x0: 33, y0: 18, x1: 35, y1: 20 } },
  { id: "lot_n5", house: { x0: 56, y0: 17, x1: 60, y1: 21 }, bed: { x: 58, y: 19 }, door: { x: 58, y: 17 }, doorSide: "N", plot: { x0: 61, y0: 18, x1: 63, y1: 20 } },
  { id: "lot_n6", house: { x0: 64, y0: 17, x1: 68, y1: 21 }, bed: { x: 66, y: 19 }, door: { x: 66, y: 17 }, doorSide: "N", plot: { x0: 60, y0: 18, x1: 62, y1: 20 } },
  // south-road gaps (doors face N onto y=54; house top row y=55)
  { id: "lot_s1", house: { x0: 30, y0: 55, x1: 34, y1: 59 }, bed: { x: 32, y: 57 }, door: { x: 32, y: 55 }, doorSide: "N", plot: { x0: 35, y0: 55, x1: 37, y1: 57 } },
  { id: "lot_s2", house: { x0: 50, y0: 55, x1: 54, y1: 59 }, bed: { x: 52, y: 57 }, door: { x: 52, y: 55 }, doorSide: "N", plot: { x0: 47, y0: 55, x1: 49, y1: 57 } },
  { id: "lot_s3", house: { x0: 12, y0: 47, x1: 16, y1: 51 }, bed: { x: 14, y: 49 }, door: { x: 14, y: 51 }, doorSide: "S", plot: { x0: 17, y0: 48, x1: 19, y1: 50 } },
  { id: "lot_s4", house: { x0: 28, y0: 47, x1: 32, y1: 51 }, bed: { x: 30, y: 49 }, door: { x: 30, y: 51 }, doorSide: "S", plot: { x0: 33, y0: 48, x1: 35, y1: 50 } },
  { id: "lot_s5", house: { x0: 56, y0: 47, x1: 60, y1: 51 }, bed: { x: 58, y: 49 }, door: { x: 58, y: 51 }, doorSide: "S", plot: { x0: 61, y0: 48, x1: 63, y1: 50 } },
  { id: "lot_s6", house: { x0: 64, y0: 47, x1: 68, y1: 51 }, bed: { x: 66, y: 49 }, door: { x: 66, y: 51 }, doorSide: "S", plot: { x0: 60, y0: 48, x1: 62, y1: 50 } },
  { id: "lot_e1", house: { x0: 84, y0: 47, x1: 88, y1: 51 }, bed: { x: 86, y: 49 }, door: { x: 86, y: 51 }, doorSide: "S", plot: { x0: 89, y0: 48, x1: 91, y1: 50 } },
];
```
Note: lots `n3..n6`, `s3..s6`, `e1` use doors facing the residential road from the inner side. For a lot whose door faces a road that the generator does NOT yet stamp on that side, either route the door to the nearest stamped road or add the lot's access spur to `ROAD_SEGMENTS` in Task 2. Keep all lot doors' exteriors on a `path` tile.

- [ ] **Step 4: TDD-converge the lots**

`RUN_TESTS tests/world/reserve-lots.test.ts`
Fix any lot whose footprint/plot isn't clear grass, whose door doesn't face a `path`, whose plot is out of range, or that overlaps. (Inner-side lots `n3..n6`/`s3..s6` need their door exterior to land on the `y=14`/`y=54` road or a trunk; nudge the lot or extend the relevant road segment.) Iterate to green.

- [ ] **Step 5: Full suite + commit**

`RUN_TESTS` (whole suite) — Expected: PASS (now 934 with the new file's tests counted; exact count = baseline + new cases).
```bash
git add src/world/map.ts tests/world/reserve-lots.test.ts
git commit -m "feat: reserve 13 road-connected lots for future homesteads

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Verify the bigger world renders and reads correctly

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Apply the node prefix, then: `"$N/node" node_modules/typescript/bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Visual check via a cheap-model browser subagent**

Dispatch a `haiku`/`sonnet` subagent (per project memory: Playwright on cheap models, text-only return) to run the dev server (`npm run dev`), open the app, and report — as text only — whether: the town fills a ~96×64 field, all 12 named agents have a house, downtown (tavern/shop/cafe) sits centrally, the park+pond render to the east, and there are no obvious gaps/overlaps. Capture one screenshot to `docs/superpowers/plans/artifacts/phase1-map.png`.

- [ ] **Step 3: Confirm determinism**

`RUN_TESTS tests/world/map.test.ts` twice; identical pass. (The generator is RNG-free, so any difference indicates an accidental nondeterministic call — fix before closing.)

---

## Self-Review (against the spec)

- **Spec "Phase 1 — Map expansion to ~96×64 sized for ~25 agents"** → Tasks 1–5: 96×64 canvas, 12 occupied + 13 reserve = 25 capacity. ✔
- **Spec "stays deterministic / fully connected"** → preserved (no RNG; road-first; `map.test.ts` connectivity gate run every task). ✔
- **Spec "≥25 reachable bed-slots exposed"** → 12 occupied beds + 13 reserve lots, all road-adjacent and (occupied) ≤40 A\* of the tavern. ✔
- **Spec "integration: verify agents layer assigns homes dynamically; flag, don't edit, if hardcoded"** → confirmed hardcoded (persona-id-keyed `HOMESTEAD_DOORS`); this plan keeps the 12 ids/positions valid and adds reserve capacity WITHOUT editing `src/agents/*`. The agents session activates a lot by adding a persona + promoting the lot to `HOMESTEADS`. Flagged here. ✔
- **Spec constraint "contracts/* out of bounds"** → narrowed to the two dimension constants only, called out as the single shared-file touch. ✔
- **Placeholder scan:** none — every step has concrete code/commands. Coordinate tables are explicitly TDD-converged against named gates.
- **Type consistency:** `ReserveLot`/`RESERVE_LOTS`/`exteriorOf` used in the test match the `map.ts` exports added in Task 5; `DoorSide`/`Vec2` already exported.

---

## Subsequent Plans (not in this document)

These were intentionally separated — each produces working, testable software and each depends on interfaces that don't exist yet, so planning them now would mean inventing APIs:

- **Phase 0 — RenderTexture base refactor.** Phaser scene-plumbing in `WorldScene.ts` (`buildBaseLayer`/`drawTileAssets`): bake the truly-static ground (grass + path + floor + interior-wall + border-fence — all frozen at runtime) into one `RenderTexture`; keep water/soil/tilled/crop as live overlays. `WorldScene` has no headless test harness, so this is verified by Playwright screenshot parity + a render-list sanity check, not vitest TDD — a different plan shape. Lands before Phase 4 (heavy scatter).
- **Phases 2–7 — the dressing** (terrain variety/transitions, organic paths, ground scatter, foliage, interiors, building structure). Their `render.ts` pure functions are TDD-able now, but the `WorldScene` blit code consumes Phase 0's `RenderTexture` layer API — so detail them after Phase 0 exists.

Recommended next: write the Phase 0 plan, implement it, then a single plan for Phases 2–7 against the real layer API.
