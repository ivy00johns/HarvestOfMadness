# Contract — Phase A close-out (A4 reserve lots + A5b park/pond east)

Single source of truth for the implement agent AND the verify critics. Pure-data
map refactor of `src/world/map.ts` + one new test. **Zero behaviour change** to the
sim; determinism (no `Math.random`, no `Date`) is LAW. Tests are the source of
truth — converge coordinates to green, never weaken a test to pass.

Run tools with the nvm-absolute node:
- tests: `node_modules/vitest/vitest.mjs run <file>`
- tsc:   `node_modules/typescript/bin/tsc --noEmit`

---

## Workflow 1 scope (this contract)

Two changes, both in `src/world/map.ts`, plus one new test file. NO other source files.

### Change 1 — A5b: relocate PARK + POND + benches EAST (keep pond exactly 4-wide)

The park currently sits upper-middle (`PARK {74,24,84,34}`). Move it east of the
civic hub, adjacent to the spine. **The pond MUST stay exactly 4 tiles wide** —
`tests/world/pathfinding.test.ts` derives the pond's east grass flank as
`WATER_POS.x + 4`; a wider pond breaks it. Keeping width 4 means ZERO change to
pathfinding.test.ts. (This intentionally deviates from Option C's 7-wide pond,
which was never load-bearing.)

Exact target values (hand-verified against the shipped 140×100 geometry):

```ts
export const PARK = { x0: 96, y0: 40, x1: 109, y1: 49 };   // east of civic hub, south edge adjacent to spine y=50
const POND       = { x0: 99, y0: 43, x1: 102, y1: 46 };    // 4 wide × 4 tall — width MUST be 4
export const WELL_POS: Vec2 = { x: 59, y: 49 };            // UNCHANGED
export const NOTICE_BOARD_POS: Vec2 = { x: 60, y: 49 };    // UNCHANGED
export const BENCH_POS: Vec2 = { x: 97, y: 48 };           // park grass, west side, inside PARK
const PARK_BENCH_POS: Vec2 = { x: 106, y: 45 };            // park grass, east side, inside PARK
```

- `WATER_POS` stays `{ x: POND.x0, y: POND.y0 }` ⇒ `{99,43}` (a water tile). Keep it derived.
- Park landmark `parkCentre` stays `{ x: PARK.x1, y: PARK.y1 }` ⇒ `{109,49}` — a GRASS tile (verified: not pond, y<50 so not spine). No test pins its position, only existence+count.
- Both benches `{97,48}` and `{106,45}` are inside PARK and on grass (not pond) ⇒ the "≥1 bench inside park" tests (map.test, typology) hold; `world.objects()` length stays **4**.
- The decor generator reads the `PARK` constant for its in-park tree-thinning and the forced park tree at `{PARK.x0, PARK.y0+1}` = `{96,41}` (grass) — both follow the move automatically.
- Update the stale doc-comments above PARK/POND/objects that describe the old "SE flat" / "{77,27}" positions.

**Pathfinding self-check (must hold, no test edit):** with `WATER_POS={99,43}`,
`POND_W={98,44}` grass, `POND_E={103,44}` grass (pond east edge is x102), row 44 is
blocked by pond (y43-46) so the detour over the top (via grass row y42) is forced ⇒
path length > 6. ✔

### Change 2 — A4: populate RESERVE_LOTS (14) + new test

`RESERVE_LOTS` is currently `[]`. Lots **stamp no tiles, add no landmark, bind no
persona** — pure capacity. So adding them does NOT change `generateMap()` tile
output (determinism/counts untouched). The new test validates them as data against
the generated map.

Starting coordinates (hand-verified to land on grass with road-adjacent doors and
in-range plots; **TDD-converge any that the test rejects** — the test is truth):

```ts
export const RESERVE_LOTS: ReserveLot[] = [
  // NORTH road (y=20), homes ABOVE it (door side S at y=19, exterior y=20 = road)
  { id: "lot_n1", house: { x0: 26,  y0: 15, x1: 30,  y1: 19 }, bed: { x: 28,  y: 17 }, door: { x: 28,  y: 19 }, doorSide: "S", plot: { x0: 31,  y0: 16, x1: 33,  y1: 19 } },
  { id: "lot_n2", house: { x0: 34,  y0: 15, x1: 38,  y1: 19 }, bed: { x: 36,  y: 17 }, door: { x: 36,  y: 19 }, doorSide: "S", plot: { x0: 39,  y0: 16, x1: 41,  y1: 19 } },
  { id: "lot_n3", house: { x0: 42,  y0: 15, x1: 46,  y1: 19 }, bed: { x: 44,  y: 17 }, door: { x: 44,  y: 19 }, doorSide: "S", plot: { x0: 47,  y0: 16, x1: 49,  y1: 19 } },
  { id: "lot_n4", house: { x0: 76,  y0: 15, x1: 80,  y1: 19 }, bed: { x: 78,  y: 17 }, door: { x: 78,  y: 19 }, doorSide: "S", plot: { x0: 81,  y0: 16, x1: 83,  y1: 19 } },
  { id: "lot_n5", house: { x0: 84,  y0: 15, x1: 88,  y1: 19 }, bed: { x: 86,  y: 17 }, door: { x: 86,  y: 19 }, doorSide: "S", plot: { x0: 89,  y0: 16, x1: 91,  y1: 19 } },
  { id: "lot_n6", house: { x0: 92,  y0: 15, x1: 96,  y1: 19 }, bed: { x: 94,  y: 17 }, door: { x: 94,  y: 19 }, doorSide: "S", plot: { x0: 97,  y0: 16, x1: 99,  y1: 19 } },
  { id: "lot_n7", house: { x0: 100, y0: 15, x1: 104, y1: 19 }, bed: { x: 102, y: 17 }, door: { x: 102, y: 19 }, doorSide: "S", plot: { x0: 105, y0: 16, x1: 107, y1: 19 } },
  // NORTH road, homes BELOW it (door side N at y=21, exterior y=20 = road)
  { id: "lot_n8", house: { x0: 30,  y0: 21, x1: 34,  y1: 25 }, bed: { x: 32,  y: 23 }, door: { x: 32,  y: 21 }, doorSide: "N", plot: { x0: 35,  y0: 22, x1: 37,  y1: 25 } },
  { id: "lot_n9", house: { x0: 88,  y0: 21, x1: 92,  y1: 25 }, bed: { x: 90,  y: 23 }, door: { x: 90,  y: 21 }, doorSide: "N", plot: { x0: 93,  y0: 22, x1: 95,  y1: 25 } },
  // SOUTH road (y=80), homes BELOW it (door side N at y=81, exterior y=80 = road)
  { id: "lot_s1", house: { x0: 26,  y0: 81, x1: 30,  y1: 85 }, bed: { x: 28,  y: 83 }, door: { x: 28,  y: 81 }, doorSide: "N", plot: { x0: 31,  y0: 81, x1: 33,  y1: 84 } },
  { id: "lot_s2", house: { x0: 34,  y0: 81, x1: 38,  y1: 85 }, bed: { x: 36,  y: 83 }, door: { x: 36,  y: 81 }, doorSide: "N", plot: { x0: 39,  y0: 81, x1: 41,  y1: 84 } },
  { id: "lot_s3", house: { x0: 76,  y0: 81, x1: 80,  y1: 85 }, bed: { x: 78,  y: 83 }, door: { x: 78,  y: 81 }, doorSide: "N", plot: { x0: 81,  y0: 81, x1: 83,  y1: 84 } },
  { id: "lot_s4", house: { x0: 84,  y0: 81, x1: 88,  y1: 85 }, bed: { x: 86,  y: 83 }, door: { x: 86,  y: 81 }, doorSide: "N", plot: { x0: 89,  y0: 81, x1: 91,  y1: 84 } },
  { id: "lot_s5", house: { x0: 92,  y0: 81, x1: 96,  y1: 85 }, bed: { x: 94,  y: 83 }, door: { x: 94,  y: 81 }, doorSide: "N", plot: { x0: 97,  y0: 81, x1: 99,  y1: 84 } },
];
```

Safe central band: **x∈[26,114]** on both roads (west hamlets end ~x21 + west trunk
x24; east hamlets start x118 + east trunk x116; center trunk x70 — lots avoid columns
24/70/116). Park is y40-49 (north lots y15-25, south lots y81-85 ⇒ no overlap).

Also: keep/extend the comment block on `RESERVE_LOTS` documenting that the
countryside ring + center-trunk corridor hold room for whole future hamlets.

### New file — `tests/world/reserve-lots.test.ts`

Author a STRICT validity test (mirror the homestead plot-range test in
`tests/world/map.test.ts`). Must assert, for the generated map:

1. `RESERVE_LOTS.length >= 14`.
2. Every lot's **house footprint AND plot** are entirely `"grass"` in `generateMap().tiles` (nothing stamped — capacity is real, "visible room to grow").
3. Every lot is in bounds (`0 < x < MAP_WIDTH-1`, `0 < y < MAP_HEIGHT-1`).
4. Every lot's **door exterior** (`exteriorOf(door, doorSide)`) is a `"path"` tile (drop-in activation).
5. Every lot's plot nearest cell is within `OBSERVATION_RADIUS` (Chebyshev-4) of its door.
6. No lot footprint overlaps any non-grass tile, and no two lot footprints overlap each other.

Import `OBSERVATION_RADIUS`, `MAP_WIDTH`, `MAP_HEIGHT` from `@contracts/types`;
`generateMap`, `RESERVE_LOTS`, `exteriorOf` from `../../src/world/map`.

---

## Hard gates (verify must check ALL — unchanged from the build's standing invariants)

- `HOMESTEADS.length === 12`; exactly 12 `bedTile`s; landmark counts `bed=12, house=12, shop=1, tavern=1, cafe=1, school=1(none), office=1, park=1, water>=1`.
- `BUILDINGS.length === 17`; `world.objects()` length `=== 4`.
- Determinism: two `generateMap()` runs are byte-identical (deep-equal tiles/landmarks/decor/objects).
- Pond is exactly 4 wide; pathfinding pond-detour test green WITHOUT editing it.
- Reserve lots valid per the 6 assertions above.
- Reach floor unchanged (party-emergence ≤100 still green).
- Full suite (~1073 + new reserve-lots cases) green; `tsc --noEmit` clean.

## File ownership
- `src/world/map.ts` — implement agent (sole writer)
- `tests/world/reserve-lots.test.ts` — implement agent (new)
- Any other test: ONLY if a coordinate it hardcodes genuinely breaks — but per recon, all park/pond refs are self-relative; expect NO other test edits. If one breaks, it is a real coordinate that must be FIXED, never an assertion to weaken.
