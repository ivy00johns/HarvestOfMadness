# World Expansion — Building Typology + Organic Layout (Wave 5a)

> Break the symmetric grid into a varied, Smallville-feeling town: distinct building TYPES with distinct furnished interiors, placed in an organic asymmetric layout. Riskiest map change since Wave 1 (11 coupled test files). Deterministic, additive, no new art needed. Suite 912 green → **912+ green + `tsc` clean**.

## Ground truth
- `src/world/map.ts`: `HOMESTEADS[12]` (5x5 `stampRoom`), `BUILDINGS[14]` (`kind: house|shop|tavern`), `generateMap()` stamps wall border → roads (spine y=20 + verticals x=12/26/40) BEFORE rooms (so every door's exterior neighbour is `path`), → rooms/plots → pond → decor (cap 16, coprime `(x*7+y*13)%17===0`). Back-compat exports: SHOP_POS/BED_POS/HOUSE_POS/WATER_POS/FIELD_RECT/HOMESTEAD_DOORS/WORLD_OBJECTS/WELL_POS/NOTICE_BOARD_POS/BENCH_POS. `floor` passable, walkable interiors shipped.
- `contracts/types.ts:70` `Landmark.kind = shop|bed|water|house|tavern`. Narrowed in: Planner.ts:30 LANDMARK_KINDS, mock.ts:159-164 (filter DROPS unknown kinds), prompts.ts:287 prose.
- WorldScene.ts: `dressBuildings()` (698) iterates BUILDINGS, picks signFrame per kind, calls `paintInterior(b, signFrame)` (742) — already kind-branched (house/shop/tavern) using INTERIOR_FRAMES/FURNITURE_FRAMES (render.ts). `buildingStyle.ts` already has library/school entries (test enumerates them). Every asset `put` guarded by textures.exists (placeholder fallback).
- Art (verified in-sheet): interior.png (floors 64/65, shelf 96, cabinet 98, barrels 129, BAR 100, + stoves/clocks/tables lower rows), blonde-wood (bed 208/209/224/225, tables ~124/125, benches/bookshelves), decorations signs row0-1 (BOARD 6, swords 7, JUG 8, BREAD 9, BOOK 22, BEER 23, INN 24). NO blocking art gaps — all 7 types furnish from existing frames; only additive SIGN_FRAMES.JUG(8)/BOOK(22) needed.

## 1. Building TYPE set (7)
Widen `BuildingFootprint.kind` → `BuildingKind = "house"|"shop"|"tavern"|"cafe"|"office"|"school"` (+ park is a region, not a room). Final BUILDINGS = **12 houses (size-varied 5x5/4x4/6x5) + shop(5x5) + tavern(7x5) + cafe(5x4) + office(5x5) + school(6x5) = 17 rooms**; park = open 8x6 region w/ inner pond + benches + trees (NOT a walled room).
- **KEEP 12 houses** (size-varied) — preserves the 12-bed/12-house/persona contract (lowest risk). Variety from SIZE + organic placement, not count.
- shop/tavern keep their `kind` strings exactly (landmark + brain resolution unchanged). cafe/office/school are net-new room kinds (environmental only in 5a).
- Furnishing templates (paintInterior, existing frames): cafe = BAR counter + 2 small tables + chairs; office = 2 cabinets (desks) + table + chair + shelf; school = 2 bookshelves + 2 tables + chairs. Signs: cafe=JUG(8), office=BOARD(6), school=BOOK(22), shop=BREAD(9), tavern=BEER(23).

## 2. Organic asymmetric layout (deterministic — NO Math.random/Date.now)
- Hand-authored spec tables (this is what gives the "organic, hand-feeling" result): varied-size `HOMESTEADS[12]` + a `COMMONS` table {kind, rect, door, doorSide, specialTile?} for shop/tavern/cafe/office/school + a `PARK` region rect.
- Replace rigid 3-verticals with a `ROAD_SEGMENTS: {x0,y0,x1,y1}[]` constant (a downtown loop around a plaza + residential spurs + park access). **KEEP a main connector path row at y=20** (pathfinding.test SPINE_Y=20 straight-path + party-emergence reachability math) and a **≥4-wide pond** (pathfinding pond-detour test).
- Stamp order: wall border → roads → rooms → park. Guarantees (authored + test-validated): every door's exterior neighbour is `path` (per-building `doorSide`); each house plot's nearest cell ≤ Chebyshev OBSERVATION_RADIUS(4) of its door; full connectivity (BFS reaches every door+bed+room); **max door→tavern A* path ≤ 40** (tavern central; party-emergence reachability test is the gate — author positions to satisfy, run it).
- Park: stamp inner pond (water), rest grass; bias a few decor trees into the park region (still capped 16, still deterministic); add 1-2 bench WorldObjects in the park (additive WORLD_OBJECTS).

## 3. map.ts changes
- `BuildingKind` union + `BuildingFootprint.kind` widen + `doorSide?: DoorSide`. `stampRoom` unchanged (size-agnostic).
- Varied-size HOMESTEADS[12] (keep ids, bed interior cell, plot). HOMESTEAD_DOORS derives unchanged (personas.ts unaffected).
- COMMONS table (shop/tavern/cafe/office/school). shop carries shopTile; tavern landmark = door-gap.
- ROAD_SEGMENTS + PARK constants. Keep y=20 connector.
- BUILDINGS = [...12 houses, shop, tavern, cafe, office, school] (17), each spec→footprint with kind+doorSide.
- Landmarks: bed×12 + house×12 + shop×1 + tavern×1 + water (unchanged) + ADD cafe×1, office×1, park×1 (additive). school emits NO landmark in 5a (keep counts crisp).
- Back-compat exports ALL preserved (re-place WELL/NOTICE_BOARD/BENCH near new plaza; keep board=well+(1,0) and bench-adjacent-to-water for objects.test). WATER_POS may be the park pond corner.
- Decor scatter unchanged (cap 16 + coprime).

## 4. contracts/types.ts (additive)
`Landmark.kind` += `"cafe"|"office"|"park"`. Ripple (all additive/benign): Planner.ts:30 LANDMARK_KINDS += those (5b uses them; harmless now); prompts.ts:287 prose optional; **mock.ts:159-164 filter LEFT UNCHANGED** (5a is environmental — new kinds stay inert, no behavior change). PlanStep.targetLandmark auto-widens (typed Landmark["kind"]).

## 5. render/WorldScene/buildingStyle
- render.ts: `SIGN_FRAMES.JUG=8, BOOK=22` (additive, row 0-1 → render-mapping sign-row test passes). Optional INTERIOR aliases (DESK→CABINET, COUNTER→BAR; no new indices).
- WorldScene: `dressBuildings` → `signFrameForKind(kind)` lookup (all 6 room kinds). `paintInterior` → add cafe/office/school branches (templates §1). Park trees via existing decor/tree path; park pond via water tile; benches via dressWorldObjects (existing placeholder). House/shop/tavern branches unchanged.
- buildingStyle.ts: extend BuildingKind union + STYLES with cafe(☕)/office(🏢)/park(🌳); KEEP existing library/school; distinct signs/tints; keep house tint 0xffffff, shop 🛒, tavern 🍺.

## 6. Test re-spec (the #1 risk — make EVERYTHING structure-derived; 11 files + 1 new)
- **map.test.ts:** house loop derives x1/y1 from spec size (not +4); perimeter=walls + 1 door floor, interior=floor + 1 bed (varied sizes). beds===12, building===0, bed/house===12, shop/tavern===1, water≥1; ADD cafe/office/park landmark===1. BUILDINGS length 14→**17**; generalize built-tile sweep + doorX-in-range per kind. connectivity BFS reaches every door+bed AND cafe/office/school doors. plot-radius unchanged. decor cap 16 (park trees still grass). NEW: every BuildingKind appears ≥1; houses have ≥2 distinct sizes; park region walkable grass + inner water + ≥1 bench within it; each non-house door exterior neighbour is path.
- **world.test.ts:** HOUSE_WALL/FLOOR/SOIL/WATER/BED_POS/SHOP_POS derive from exports — no change (re-verify WATER_POS is water). landmark four-kind test unchanged; optionally ADD cafe/office/park exist.
- **observation.test.ts:** landmark counts bed/house===12, shop/tavern===1, water===1 KEEP; ADD cafe/office/park===1 if exhaustive. **RE-VALIDATE hardcoded open-grass coords** (lines ~117-119 {9,18}/{10,19}/{13,18}, 136-142) — pick tiles guaranteed grass/room-free in the new layout or derive from map.
- **executor-matrix.test.ts (TOP re-spec risk):** SOIL/SOIL_STAND/HOUSE_WALL/INTERIOR_FLOOR/BED_POS/SHOP_POS/WATER_POS derive from exports — keep HOMESTEADS[0] ≥4x4 so INTERIOR_FLOOR (house+{1,1}) ≠ door ≠ bed. RE-VALIDATE hardcoded OPEN={3,18}, TALKER={10,18}, {3,6}, {10,20} against new tile types; fix each.
- **economy-invariants.test.ts / demo-loop.test.ts:** derive from FIELD_RECT — no change.
- **pathfinding.test.ts:** KEEP y=20 open path row spanning x 4..10 (straight 7-tile test) + ≥4-wide pond w/ grass flanks at WATER_POS.x-1 / +4 on row WATER_POS.y+1 (else re-spec POND_W/POND_E).
- **party-emergence.test.ts:** TAVERN_POS derives from landmark — no edit; the ≤40-tile reachability test is the gate (author layout to pass; run it).
- **personas.test.ts:** derives from HOMESTEAD_DOORS — no change (start on floor door-gap, nearest-bed-own-bed hold by construction).
- **render-mapping.test.ts:** JUG(8)/BOOK(22) in row 0-1 pass; other constants unchanged; ADD non-negative for any new aliases.
- **buildingStyle.test.ts:** extend ALL_KINDS to include cafe/office/park (or keep — only checks listed kinds); assert distinct signs/tints; keep house/shop/tavern values.
- **NEW tests/world/typology.test.ts:** each of 6 room kinds built (wall ring + door + special tile) + door reachable from tavern; houses span ≥2 sizes; downtown cluster bounded near plaza; park walkable + water + ≥1 bench + ≥1 tree inside.

## 7. Ownership (Wave 5a owns)
src/world/map.ts (primary), src/world/render.ts, src/scenes/WorldScene.ts, src/obs/buildingStyle.ts, contracts/types.ts (Landmark.kind widen ONLY — additive), src/agents/Planner.ts:30 + src/llm/prompts.ts:287 (additive LANDMARK_KINDS/prose), + the 11 test files in §6 + NEW typology.test.ts. mock.ts filter LEFT UNCHANGED. Does NOT touch src/agents cognition (Needs/Goals/Roles/Cognition/Conversation/EventBoard/Governance) — those are the brain waves. FLAG: contracts/types.ts is a shared seam with the (deferred) gossip/governance work — this wave ONLY widens Landmark.kind; touch no SimEvent/Conversation/MemoryEntry/ActionType.

## 8. Risks
1. Incomplete test re-spec (red suite) → §6 enumerates every assertion; structure-derive; the hardcoded open-grass probes in executor-matrix + observation and SPINE_Y/pond in pathfinding are the top risk — keep y=20 connector + ≥4-wide pond, re-validate each literal.
2. Broken connectivity / >40-tile reachability → road-first; per-building doorSide exterior-is-path; tavern central; real-A* reachability test is the gate (run it).
3. Art gaps → none blocking (in-sheet frames + additive sign frames); placeholder fallback preserved.
4. Break brain bed/shop/tavern resolution → keep kind strings + 12 bed/house + 1 shop/tavern landmarks at valid tiles; mock filter unchanged; one-bed-per-house preserves nearest-bed=own-bed.
5. Non-deterministic generation → hand-authored spec tables + fixed ROAD_SEGMENTS + coprime decor; zero RNG.

## 9. Build sequence
contracts Landmark.kind widen → tsc → map skeleton (BuildingKind, varied HOMESTEADS, COMMONS, ROAD_SEGMENTS, PARK; keep y=20 connector + back-compat exports) → generateMap (roads→rooms→park; landmarks; BUILDINGS[17]; park benches) → render (SIGN_FRAMES, signFrameForKind, paintInterior cafe/office/school, buildingStyle) → re-spec 11 tests + new typology.test (run party-emergence reachability FIRST as the layout canary; re-validate every hardcoded coord) → full vitest ≥912 green + tsc clean → boot once with assets + once with manifest removed (placeholder).
