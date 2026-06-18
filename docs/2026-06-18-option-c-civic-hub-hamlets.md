# Option C — Civic Hub + Hamlets (140×100, built to grow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-lay the town as a **140×100** civic-hub-plus-hamlets layout that fixes the "generic, empty, polka-dot" look: a dense central hub on the spine, four named hamlets (the 12 existing personas, 3 per hamlet), 14 pre-zoned reserve lots down the empty middle of both residential roads, and a deliberate countryside ring for whole future hamlets. Density — not map size or new assets — is the fix; this plan also lands the deferred "dressing" (decor clusters + interior fill) that makes it read alive.

**Architecture:** A pure-data re-layout of `src/world/map.ts` (road segments, hub `COMMONS`, `HOMESTEADS`, `RESERVE_LOTS`, `PARK`/`POND`, decor scatter), a 2-constant dimension bump in `contracts/types.ts`, **one engine constant change** (the party reach budget — see Gate 3), camera tuning in `src/config.ts`, and the WorldScene decor/interior rendering that consumes the data. Correctness is driven by the existing coordinate-agnostic `tests/world/map.test.ts`, the agents-layer `tests/agents/party-emergence.test.ts`, and a new `tests/world/reserve-lots.test.ts`.

**Tech Stack:** TypeScript, Vitest, deterministic (zero-RNG, zero-`Date`) generative map. Run node tools with the project's nvm prefix (see your existing plans).

---

## Why this layout (the diagnosis, in one paragraph)

The current build lays a uniform road grid first, drops small buildings into the resulting cells, and caps decor at 16 trees placed one-per-grass-cell. That mathematically produces big empty lots with lonely trees — the "parking lot" look. the_ville feels alive because buildings are large and packed, negative space is tight, foliage is dense and clustered, and interiors are full (~1,360 furniture tiles vs HOM's ~150). **You already own every asset needed** (CREDITS lists modular/Victorian buildings, city-outside props, medieval decorations, cobble paths, wooden furniture, interiors, fruit trees, terrains with transitions, flowers). The gap is placement. This plan changes placement.

---

## Hard Gates (every task keeps these true)

1. `HOMESTEADS.length === 12`; exactly 12 `bedTile`s; landmark counts: `bed=12, house=12, shop=1, tavern=1, cafe=1, school=1, office=1, park=1, water≥1`.
2. Persona ids unchanged and intent preserved: **north hamlets** get `brix, ford, wren` (NW) and `dora, gus, clem` (NE); **south hamlets** get `fern, nell, sage` (SW) and `rusty, moss, zola` (SE). `HOMESTEAD_DOORS` keeps all 12 keys (consumed by `src/agents/personas.ts`).
3. **REACH BUDGET CHANGE (do this first — see Task 0). DECIDED:** raise the hard reachability bound from **40 → 100** (true corner-to-tavern A* is ~95; 100 gives headroom). On a 140-wide map a corner hamlet is ~90 tiles from a central tavern, so 40 is geometrically impossible. The 100 bound only asserts a door *can* reach the tavern — it is **not** the distance at which agents decide to attend. Attendance is made realistic separately (Task 0 Step 4): travel cost weights the invite/attend decision, so distant-hamlet agents genuinely skip far gatherings. Reserve lots sit near center and clear the bound comfortably.
4. Each homestead plot's nearest cell is within **Chebyshev 4** (`OBSERVATION_RADIUS`) of its door.
5. Road-first invariant: every door's exterior neighbour is a `path` tile; every door / bed / shopTile reachable from the tavern through passable tiles.
6. Determinism: no `Math.random`, no `Date`. Re-running `generateMap()` yields the identical map.
7. `RESERVE_LOTS.length >= 14`; each lot is clear grass, in bounds, road-adjacent door, plot in Chebyshev-4 range, non-overlapping.

---

## Layout overview (140×100)

```
        x=0 ........................................................ x=139
 y=0   ┌──────────────────────────── wall ring ───────────────────────────┐
 y=14  │ NW hamlet            ── north residential road (y=20) ──   NE hamlet│
 y=20  │ brix ford wren  [····· reserve lots / EXPANSION ·····]  dora gus clem│
 y=36  │                                                                    │
 y=42  │        shop  TAVERN  café        PARK + POND (x96–109)             │
 y=50  │ ═════════════════════ main spine (y=50) ═══════════════════════   │
 y=51  │              school   office                                       │
 y=74  │ SW hamlet           ── south residential road (y=80) ──   SE hamlet│
 y=80  │ fern nell sage  [····· reserve lots / EXPANSION ·····]  rusty moss zola│
 y=99  └────────────────────────────────────────────────────────────────────┘
   trunks tie north road ↔ spine ↔ south road at x=24, x=70 (center), x=116
```

The **outer road segments** carry the four occupied hamlets; the **central segments** (x≈25–69 and 71–115 on both roads) are intentionally empty, pre-zoned as reserve lots and future-hamlet ground. The whole map perimeter is countryside woodland — room for entirely new hamlets later with zero re-survey.

---

## Task 0: Bump dimensions, raise the reach budget, retune camera

**Files:** `contracts/types.ts` (2 constants), the party-reach constant (Gate 3), `src/config.ts`.

- [ ] **Step 1 — green baseline.** Run the suite; confirm pass before changes.
- [ ] **Step 2 — dimensions.** In `contracts/types.ts`:
```ts
export const MAP_WIDTH = 140;   // was 96
export const MAP_HEIGHT = 100;  // was 64
```
Leave `TILE_SIZE = 32`, `OBSERVATION_RADIUS = 4` untouched.
- [ ] **Step 3 — reach budget (Gate 3, DECIDED).** Find the ≤40 bound asserted in `tests/agents/party-emergence.test.ts` (and any `MAX_PARTY_REACH` / `REACH_BUDGET`-style constant it reads). Raise it to **100** and add a comment: `// 140x100: corner hamlet ~95 A* tiles from a central tavern; 40 was tuned for 96x64. This is a reachability floor, not an attendance threshold.`
- [ ] **Step 4 — make attendance distance-realistic (the "more realistic" half).** In the gathering invite/attend logic, weight the decision by travel cost rather than a hard cutoff: an agent is less likely to accept or walk to an event as `pathTiles` grows (and as energy drops). A simple, tunable form: `attendProb = clamp(1 − pathTiles / DECAY, floor, 1)` with `DECAY ≈ 70`, plus the existing persona/relationship factors. Result: nearby hamlets pack the tavern, far hamlets show up occasionally for big events — believable, and it makes the hub genuinely central without forcing everyone. Keep it behind the existing mock/live split so mock mode stays deterministic. (If the team prefers minimal scope now, ship Step 3 alone — every door still reaches the tavern; only the realism polish waits.)
- [ ] **Step 5 — camera.** In `src/config.ts`, retune for 140×100 (4480×3200 world px): `DEFAULT_ZOOM = 1.2`, `CAMERA_ZOOM_MIN = 0.28`, `CAMERA_ZOOM_MAX = 3`, `CAMERA_PAN_SPEED = 1100`. Update the doc comments that hardcode the old size.
- [ ] **Step 6 — run + commit.** Suite green (old rooms sit < 96×64 inside the bigger canvas — the town clusters NW, which is the expected test-green intermediate). Commit `feat: enlarge canvas to 140x100 and raise the party reach budget`.

---

## Task 1: Road network

**Files:** `src/world/map.ts` (`SPINE_Y`, `ROAD_SEGMENTS`).

- [ ] **Step 1 — replace road tables.** Roads are 1-tile centerlines in the tile grid (render 2–3 tiles wide for the look; visual width does not change collision/gates).
```ts
const SPINE_Y = 50;

export const ROAD_SEGMENTS: RoadSeg[] = [
  { x0: 6,  y0: 50, x1: 134, y1: 50 }, // main spine
  { x0: 10, y0: 20, x1: 130, y1: 20 }, // north residential road
  { x0: 10, y0: 80, x1: 130, y1: 80 }, // south residential road
  { x0: 24, y0: 20, x1: 24,  y1: 80 }, // west trunk
  { x0: 70, y0: 20, x1: 70,  y1: 80 }, // center trunk (also future-hamlet access)
  { x0: 116, y0: 20, x1: 116, y1: 80 }, // east trunk
];
```
Door exteriors land on these lines: north-road homes' doors at `y=19` (face S, exterior `y=20`) or `y=21` (face N, exterior `y=20`); south-road at `y=79`/`y=81` (exterior `y=80`); hub doors on `y=49`/`y=51` (exterior `y=50`).

---

## Task 2: Civic hub (COMMONS)

**Files:** `src/world/map.ts` (`COMMONS`, `WELL_POS`, `NOTICE_BOARD_POS`).

- [ ] **Step 1 — replace `COMMONS`.** Five buildings straddle the spine; all doors open onto `y=50`.
```ts
const COMMONS: CommonsSpec[] = [
  { kind: "shop",   rect: { x0: 50, y0: 43, x1: 57, y1: 49 }, door: { x: 53, y: 49 }, doorSide: "S", specialTile: { x: 53, y: 46 } },
  { kind: "tavern", rect: { x0: 62, y0: 42, x1: 70, y1: 49 }, door: { x: 66, y: 49 }, doorSide: "S" },
  { kind: "cafe",   rect: { x0: 73, y0: 44, x1: 79, y1: 49 }, door: { x: 76, y: 49 }, doorSide: "S" },
  { kind: "school", rect: { x0: 60, y0: 51, x1: 68, y1: 58 }, door: { x: 64, y: 51 }, doorSide: "N" },
  { kind: "office", rect: { x0: 72, y0: 51, x1: 79, y1: 57 }, door: { x: 75, y: 51 }, doorSide: "N" },
];

export const WELL_POS: Vec2 = { x: 59, y: 49 };          // plaza patch between shop and tavern
export const NOTICE_BOARD_POS: Vec2 = { x: 60, y: 49 };
```
Tavern door `(66,49)` is the reach anchor for Gate 3.

---

## Task 3: The 12 occupied homesteads (4 hamlets × 3)

**Files:** `src/world/map.ts` (`HOMESTEADS`). Houses are 5×5/5×6 with a divider wall + door gap = two rooms (keep the BFS bed-reachability invariant). Plots are 3×4 soil rects, ≤ Chebyshev-4 from the door.

- [ ] **Step 1 — replace `HOMESTEADS`.**
```ts
export const HOMESTEADS: HomesteadSpec[] = [
  // ── NW hamlet (north intent; doors onto north road y=20) ──
  { id: "brix", house: { x0: 7,  y0: 14, x1: 11, y1: 19 }, bed: { x: 9,  y: 16 }, door: { x: 9,  y: 19 }, doorSide: "S", plot: { x0: 12, y0: 15, x1: 14, y1: 18 } },
  { id: "ford", house: { x0: 16, y0: 14, x1: 20, y1: 19 }, bed: { x: 18, y: 16 }, door: { x: 18, y: 19 }, doorSide: "S", plot: { x0: 21, y0: 15, x1: 23, y1: 18 } },
  { id: "wren", house: { x0: 9,  y0: 21, x1: 13, y1: 26 }, bed: { x: 11, y: 24 }, door: { x: 11, y: 21 }, doorSide: "N", plot: { x0: 14, y0: 22, x1: 16, y1: 25 } },
  // ── NE hamlet (north intent) ──
  { id: "dora", house: { x0: 118, y0: 14, x1: 122, y1: 19 }, bed: { x: 120, y: 16 }, door: { x: 120, y: 19 }, doorSide: "S", plot: { x0: 123, y0: 16, x1: 125, y1: 19 } },
  { id: "gus",  house: { x0: 127, y0: 14, x1: 131, y1: 19 }, bed: { x: 129, y: 16 }, door: { x: 129, y: 19 }, doorSide: "S", plot: { x0: 132, y0: 16, x1: 134, y1: 19 } },
  { id: "clem", house: { x0: 121, y0: 21, x1: 125, y1: 26 }, bed: { x: 123, y: 24 }, door: { x: 123, y: 21 }, doorSide: "N", plot: { x0: 126, y0: 22, x1: 128, y1: 25 } },
  // ── SW hamlet (south intent; doors onto south road y=80) ──
  { id: "fern", house: { x0: 7,  y0: 74, x1: 11, y1: 79 }, bed: { x: 9,  y: 76 }, door: { x: 9,  y: 79 }, doorSide: "S", plot: { x0: 12, y0: 75, x1: 14, y1: 78 } },
  { id: "nell", house: { x0: 16, y0: 74, x1: 20, y1: 79 }, bed: { x: 18, y: 76 }, door: { x: 18, y: 79 }, doorSide: "S", plot: { x0: 21, y0: 75, x1: 23, y1: 78 } },
  { id: "sage", house: { x0: 9,  y0: 81, x1: 13, y1: 86 }, bed: { x: 11, y: 84 }, door: { x: 11, y: 81 }, doorSide: "N", plot: { x0: 14, y0: 82, x1: 16, y1: 85 } },
  // ── SE hamlet (south intent) ──
  { id: "rusty", house: { x0: 118, y0: 74, x1: 122, y1: 79 }, bed: { x: 120, y: 76 }, door: { x: 120, y: 79 }, doorSide: "S", plot: { x0: 123, y0: 75, x1: 125, y1: 78 } },
  { id: "moss",  house: { x0: 127, y0: 74, x1: 131, y1: 79 }, bed: { x: 129, y: 76 }, door: { x: 129, y: 79 }, doorSide: "S", plot: { x0: 132, y0: 75, x1: 134, y1: 78 } },
  { id: "zola",  house: { x0: 121, y0: 81, x1: 125, y1: 86 }, bed: { x: 123, y: 84 }, door: { x: 123, y: 81 }, doorSide: "N", plot: { x0: 126, y0: 82, x1: 128, y1: 85 } },
];
```
- [ ] **Step 2 — TDD-converge** against `map.test.ts` + `party-emergence.test.ts`. Typical nudges: a plot's nearest cell > Cheb 4 (slide the plot toward the door); door exterior not on a road (a north-road door must sit at `y=19`/`y=21`); a house/plot overlaps a road or another footprint. Iterate to green. These coordinates are the designed starting point, not gospel — the tests are the source of truth.

---

## Task 4: Reserve lots (14) — the visible "room to grow"

**Files:** `src/world/map.ts` (`RESERVE_LOTS`), `tests/world/reserve-lots.test.ts` (new — copy the structure from your prior reserve-lots test). Lots stamp no tiles, add no landmark, bind no persona. Activation = add a persona + promote the lot into `HOMESTEADS`.

- [ ] **Step 1 — add `RESERVE_LOTS`.** All hang off the empty central stretches of the two residential roads (well inside the reach budget).
```ts
export const RESERVE_LOTS: ReserveLot[] = [
  // north road, above (door S, exterior y=20)
  { id: "lot_n1", house: { x0: 26, y0: 15, x1: 30, y1: 19 }, bed: { x: 28, y: 17 }, door: { x: 28, y: 19 }, doorSide: "S", plot: { x0: 31, y0: 15, x1: 33, y1: 18 } },
  { id: "lot_n2", house: { x0: 34, y0: 15, x1: 38, y1: 19 }, bed: { x: 36, y: 17 }, door: { x: 36, y: 19 }, doorSide: "S", plot: { x0: 39, y0: 15, x1: 41, y1: 18 } },
  { id: "lot_n3", house: { x0: 42, y0: 15, x1: 46, y1: 19 }, bed: { x: 44, y: 17 }, door: { x: 44, y: 19 }, doorSide: "S", plot: { x0: 47, y0: 15, x1: 49, y1: 18 } },
  { id: "lot_n4", house: { x0: 76, y0: 15, x1: 80, y1: 19 }, bed: { x: 78, y: 17 }, door: { x: 78, y: 19 }, doorSide: "S", plot: { x0: 81, y0: 15, x1: 83, y1: 18 } },
  { id: "lot_n5", house: { x0: 84, y0: 15, x1: 88, y1: 19 }, bed: { x: 86, y: 17 }, door: { x: 86, y: 19 }, doorSide: "S", plot: { x0: 89, y0: 15, x1: 91, y1: 18 } },
  { id: "lot_n6", house: { x0: 92, y0: 15, x1: 96, y1: 19 }, bed: { x: 94, y: 17 }, door: { x: 94, y: 19 }, doorSide: "S", plot: { x0: 97, y0: 15, x1: 99, y1: 18 } },
  { id: "lot_n7", house: { x0: 100, y0: 15, x1: 104, y1: 19 }, bed: { x: 102, y: 17 }, door: { x: 102, y: 19 }, doorSide: "S", plot: { x0: 105, y0: 15, x1: 107, y1: 18 } },
  // north road, below (door N, exterior y=20)
  { id: "lot_n8", house: { x0: 30, y0: 21, x1: 34, y1: 25 }, bed: { x: 32, y: 23 }, door: { x: 32, y: 21 }, doorSide: "N", plot: { x0: 35, y0: 22, x1: 37, y1: 25 } },
  { id: "lot_n9", house: { x0: 88, y0: 21, x1: 92, y1: 25 }, bed: { x: 90, y: 23 }, door: { x: 90, y: 21 }, doorSide: "N", plot: { x0: 93, y0: 22, x1: 95, y1: 25 } },
  // south road, above (door S, exterior y=80)
  { id: "lot_s1", house: { x0: 26, y0: 74, x1: 30, y1: 78 }, bed: { x: 28, y: 76 }, door: { x: 28, y: 78 }, doorSide: "S", plot: { x0: 31, y0: 74, x1: 33, y1: 77 } },
  { id: "lot_s2", house: { x0: 34, y0: 74, x1: 38, y1: 78 }, bed: { x: 36, y: 76 }, door: { x: 36, y: 78 }, doorSide: "S", plot: { x0: 39, y0: 74, x1: 41, y1: 77 } },
  { id: "lot_s3", house: { x0: 76, y0: 74, x1: 80, y1: 78 }, bed: { x: 78, y: 76 }, door: { x: 78, y: 78 }, doorSide: "S", plot: { x0: 81, y0: 74, x1: 83, y1: 77 } },
  { id: "lot_s4", house: { x0: 84, y0: 74, x1: 88, y1: 78 }, bed: { x: 86, y: 76 }, door: { x: 86, y: 78 }, doorSide: "S", plot: { x0: 89, y0: 74, x1: 91, y1: 77 } },
  { id: "lot_s5", house: { x0: 92, y0: 74, x1: 96, y1: 78 }, bed: { x: 94, y: 76 }, door: { x: 94, y: 78 }, doorSide: "S", plot: { x0: 97, y0: 74, x1: 99, y1: 77 } },
];
```
Note: a south-road "above" door at `y=78` needs its exterior at `y=79`→road `y=80`; if the test wants the door tile adjacent to the road, set door `y=79` and house bottom `y=78` (TDD will tell you). Converge to green.
- [ ] **Step 2 — future hamlets.** Document (comment + spec) that the countryside ring and the center-trunk corridor (`x≈64–76`) hold room for 2+ entirely new hamlets: add a short access stub to `ROAD_SEGMENTS`, a `greenWell`, 5–6 homes, and personas — no re-survey of existing tiles.

---

## Task 5: Park, pond, decor scatter (kill the 16-cap)

**Files:** `src/world/map.ts` (`PARK`, `POND`, decor generator), `src/scenes/WorldScene.ts` (decor + interior rendering — consumes `World.decor()`).

- [ ] **Step 1 — park + pond (east amenity, spine-connected).**
```ts
export const PARK = { x0: 96, y0: 40, x1: 109, y1: 50 };
const POND       = { x0: 99, y0: 42, x1: 105, y1: 47 }; // grass border inside park
export const BENCH_POS: Vec2 = { x: 97, y: 48 };
```
Park south edge touches the spine (`y=50`) → connected. Add the `park` landmark.
- [ ] **Step 2 — decor density rules (replace the `decor.length < 16` scatter).** Deterministic, RNG-free (hash on `x,y` as you do now). Target **~500** items:
  - **Rim woodland:** within 8 tiles of the wall ring, place trees with density falling off toward the interior. This makes the map edge read as forest, not wasted lots.
  - **Clusters:** seed ~80 cluster centers on open grass; each drops 3–8 trees in a ~6-tile clump. Denser in the central expansion stretches so unbuilt ground reads as countryside, not void.
  - **Avenue trees:** a row of trees flanking each trunk/road at ±2 tiles.
  - **Bushes + flower tufts:** scatter ~250 on remaining grass using the credited `flowers.png` + bush tiles. Never one-tree-per-cell.
  - Keep all decor off paths/buildings/plots/water (occupancy check, as today).
- [ ] **Step 3 — interior fill (~1,300 pieces total, the biggest "alive" lever).** Per building kind, place furniture from the credited wooden-furniture + interiors packs:
  - **home:** bed, nightstand, table + 2 chairs, shelf, rug, a plant (~8–10 per home × 26 = ~230).
  - **tavern:** bar counter + 6–8 tables each with 2–4 stools (~30).
  - **shop:** 3–4 shelf aisles + a checkout counter (~16).
  - **school:** a desk grid + a board (~24).
  - **café / office:** small tables / desks along walls (~12 each).
  - The bulk target is met by furnishing every home and every reserve home as it activates.
- [ ] **Step 4 — typecheck + browser check.** Dispatch a cheap-model Playwright subagent: confirm the 140×100 town fills the field, hub central, 4 hamlets with all 12 named agents, reserve ghosts are empty grass (no stamped tiles), foliage is dense/clustered, interiors furnished, park+pond east. Screenshot to `docs/.../artifacts/option-c.png`.

---

## Final verification

- [ ] `vitest run` — all suites green (map structure/counts/connectivity, personas, party-emergence with the 95 budget, reserve-lots).
- [ ] `tsc --noEmit` — clean.
- [ ] `vite build` — succeeds.
- [ ] Determinism: run `map.test.ts` twice, identical.
- [ ] Browser: dense, packed, furnished, alive — and visibly room to grow (empty reserve stretches + countryside ring).

---

## Self-review against the gates

- 12 homesteads, 3 per hamlet, north/south intent preserved (Gate 1, 2). ✔
- Reach budget raised 40→95 with rationale; corner hamlets ~90 A* from tavern (Gate 3). ✔
- Plots ≤ Cheb 4 of doors; converge in Task 3 Step 2 (Gate 4). ✔
- Road-first; all doors' exteriors on `y=20`/`50`/`80` lines (Gate 5). ✔
- No RNG/Date in the generator (Gate 6). ✔
- 14 reserve lots, central, road-adjacent, in-range (Gate 7). ✔
- Density: ~500 decor (clusters + rim + avenues), ~1,300 interior — the actual "alive" levers, all from owned assets. ✔
- Expansion: empty central road stretches + countryside ring + center-trunk corridor for future hamlets. ✔

## Out of scope (fast-follows)

- Per-hamlet visual identity (roof-color palette per hamlet from the modular recolors).
- Terrain transition tiles (grass↔dirt↔path edges) and a second pond — the rest of the deferred "dressing" phases.
- Agent-layer activation flow for promoting a reserve lot to a live homestead (add persona + move lot into `HOMESTEADS`).
