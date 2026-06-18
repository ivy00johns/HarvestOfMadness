# Walkable Interiors + Enlarged Furnished Rooms + Map Relayout — Implementation Spec

> Wave-1 workstream **A**. XL / high-risk. User-approved (enlarged rooms + relayout, "true Smallville scale"). Suite is 768 green; the bar is **768+ green + `tsc` clean** after.

## 0. Core idea
Passability is purely tile-type driven: `src/world/Tile.ts` `PASSABLE_TYPES` → `World.isPassable` → A* (`src/world/Pathfinding.ts`). So: add a passable `floor` TileType, stamp houses as a **`wall` ring + one `floor` door-gap + a `floor` interior**, and door-only entry + interior routing come **for free** — no "portal" concept, no pathfinding change. The bulk of the effort is **test migration** (coordinate-coupled assertions → structure-derived).

## 1. Map design
- **Dimensions: `MAP_WIDTH=64`, `MAP_HEIGHT=40`** (was 48×32). Justify: 12 houses grow 3×3→5×5 (+192 tiles), plots must stay within `OBSERVATION_RADIUS=4` of the door, commons needs enlarged shop (5×5) + walkable tavern (7×5) + well/board/bench + pond + roads. 48×32 cannot absorb this without overlap or breaking observation radius. 64×40 = 2560 tiles = comfortable slack; camera auto-frames any size.
- **Road network:** horizontal spine `path` at **y=20** (x=1..62); three verticals `path` at **x=12, x=26, x=40** (y=1..38). Stamp roads FIRST, then rooms.
- **Per-house 5×5 stamp** (`W`=wall, `.`=floor passable, `B`=bedTile, `D`=floor door-gap whose outside neighbour is a road):
  ```
  W W W W W      south-door variant       east-door variant: D replaces a mid-right wall cell
  W . . . W
  W . B . W      B = bedTile on interior floor (exactly 1 per house)
  W . . . W
  W W D W W      D = floor door-gap (exactly 1 perimeter floor); tile outside D is path
  ```
  Invariant per house: perimeter = 15 `wall` + exactly 1 `floor` (the door, == `h.door`); interior 3×3 = 8 `floor` + exactly 1 `bedTile` (== `h.bed`); tile outside the door is passable road/path.
- **Tavern 7×5** = 5×3 = 15 interior floor tiles (≥6 agents converge during parties). Tavern landmark `pos` = the door-gap floor tile. No special interior tile type (tavern is landmark-only).
- **Shop 5×5** with `shopTile` on the center interior cell (BUY/SELL gate unchanged).
- **Pond** 4×4 `water` relocated to an open lower-mid/center area, clear of houses/roads; bench on adjacent grass.
- **Macro layout:** N homestead band (y≈3), upper-mid band (y≈12) flanking the central commons (shop + tavern + well/board), spine at y=20, lower-mid band (y≈24), S homestead band (y≈30). Persona→quadrant keeps `personas.ts` intent. Exact anchors are the implementer's to finalize against the structural tests (any self-consistent placement that satisfies the constraints below passes).

## 2. Contract changes (`contracts/types.ts`)
- `TileType` += `"floor"` (passable, NOT tillable) → 10 types. **Keep `building`** (no tile stamps it anymore; remains a valid impassable type — avoids churn in `TILE_COLORS`, placeholder switch, and the `isPassable(building)===false` assertion). Document "retained-but-unused".
- `MAP_WIDTH=64`, `MAP_HEIGHT=40`. `TILE_SIZE=32`, `OBSERVATION_RADIUS=4` unchanged.
- **`src/config.ts` `TILE_COLORS` is `Record<TileType, number>`** → add `floor: 0x8b6f47` (warm wood) or it will NOT typecheck. Do this in the same step as the union edit; run `tsc --noEmit` immediately. (Grep `Record<TileType` across `src/` — only `TILE_COLORS` matched.)

## 3. `src/world/map.ts`
- New `HomesteadSpec`: `{ id, house:Vec2 /*5×5 top-left*/, bed:Vec2 /*interior floor cell*/, door:Vec2 /*perimeter door-gap*/, doorSide:"N"|"S"|"E"|"W", plot:{x0,y0,x1,y1} }`. `door` is now the door-gap (a `floor` tile), no longer "path in front of bed". Persona start (`HOMESTEAD_DOORS`) = the door tile (now passable `floor`).
- New `stampRoom(tiles,x0,y0,x1,y1,door)`: perimeter→`wall`, interior→`floor`, then door cell→`floor`. Rewrite `stampHomestead` to call it, then set bedTile, fill plot soil, push bed + house landmarks (house landmark pos = door).
- **Placement rules (all must hold):** (1) door-gap on perimeter; (2) door's exterior neighbour is `path` (stamp roads first; add a 1-wide `path` stub from the door's outside neighbour to the nearest road if the edge doesn't touch one); (3) exactly one bedTile per house on interior floor; (4) plot's nearest cell ≤ Chebyshev 4 of the door; (5) no overlaps (houses/plots/roads/pond/commons/wall-ring disjoint); (6) full connectivity over passable tiles incl. `floor`.
- Commons: `stampRoom` shop (5×5) then set `shopTile`; `stampRoom` tavern (7×5), landmark pos = tavern door. Relocate pond + objects; **keep well/notice_board exactly 1 tile apart on the same row** (preserves `objects.test.ts` adjacency geometry — board = well + (1,0)).
- `BUILDINGS`: homestead spans `+4`, shop `+4`, tavern `+6`; `doorX = door.x`; length stays 14.
- Back-compat exports keep names/types, new values: `SHOP_POS`→shopTile, `BED_POS`→`HOMESTEADS[0].bed`, `HOUSE_POS`→`HOMESTEADS[0].door` (now `floor`, was `path`), `WATER_POS`→pond corner, `FIELD_RECT`→`HOMESTEADS[0].plot`, `HOMESTEAD_DOORS` derived (now `floor`), `WELL_POS`/`NOTICE_BOARD_POS`/`BENCH_POS`/`WORLD_OBJECTS` new coords. Decor scatter loop auto-adapts (keep `<16` cap + coprime scatter).

## 4. `src/world/Tile.ts`
Add `"floor"` to `PASSABLE_TYPES`. `TILLABLE_TYPES` unchanged (floor not tillable → `till(floor)` rejects "is floor").

## 5. Pathfinding — NO CHANGE
`Pathfinding.ts` / `World.findPath` / `World.isPassable` / `Grid` need no edits. (Optional: fix the stale "Small map (24x18)" comment.)

## 6. Render
- **`src/world/render.ts`:** keep `INTERIOR_FRAMES`/`FURNITURE_FRAMES`; add a few constants for the bigger rooms (e.g. `FURNITURE_FRAMES.CHAIR_L/CHAIR_R`, `INTERIOR_FRAMES.BAR`, optional `TABLE_SMALL`) — verify indices against committed `interior.png`/`blonde-wood.png`; fall back to existing constants if a cell doesn't exist. Add matching non-negative-index assertions to `render-mapping.test.ts`.
- **`src/scenes/WorldScene.ts` `drawTileAssets`:** fold `floor`/`bedTile`/`shopTile` into one branch painting `INTERIOR_FRAMES.FLOOR` at the floor/overlay depth. Split `wall`: map-border wall (`x===0||y===0||x===MAP_WIDTH-1||y===MAP_HEIGHT-1`) → `fence` (unchanged); interior house wall → `INTERIOR_FRAMES.WALL[x%len]` (open-roof cutaway edge). Keep `case "building"` as a dead-but-valid `break`.
- **`paintInterior`:** single-owner rule — the tile layer owns floor+wall; trim `paintInterior` to **furniture + sign only** (remove its floor-fill and wall-strip loops to avoid double-paint). Place furniture on interior floor cells at `DEPTH_PROP` by kind: house = bed 2×2 over the bedTile + table + 2 chairs + shelf; tavern = bar counter + 1–2 tables + corner barrels; shop = counter/shelves/cabinet + door crates, shopTile kept clear. Furniture is decoration only (passability is tile-driven; agents may visually overlap a table — depth-sort keeps them on top).
- **Depth sort: NO rewrite.** Per-frame `setDepth(container.y + TILE_SIZE/2)` (≥48 for any on-map tile) already sorts agents above furniture (≤`DEPTH_PROP`=3) and floor. Do NOT add an inside-flag. Confirm furniture/back-wall stay at ≤`DEPTH_PROP`.
- **Placeholder fallback preserved:** `drawTilePlaceholder` paints `TILE_COLORS[floor]` → interiors render in zero-asset mode; "boot with assets missing" rule intact.

## 7. TEST MIGRATION (the #1 risk — enumerate every coordinate)
Convert every map-coordinate literal to derive from `HOMESTEADS`/`BUILDINGS`/exports/`MAP_WIDTH`/`MAP_HEIGHT`/landmarks. After, re-grep `tests/` for `\b48\b`, `\b32\b` (legit remaining: embeddings-cap 32 in server/embed/memory/retrieval tests — unrelated) and bare `{ x:` literals; justify each.

- **`tests/world/map.test.ts`** (major, make structural): use `MAP_WIDTH/HEIGHT` not 48/32; rewrite the house-tile loop to assert perimeter=15 wall + 1 floor(==door), interior=8 floor + 1 bedTile(==bed); bedTile count stays 12; landmark counts unchanged; connectivity BFS keeps `impassable={wall,water,building}` (do NOT add floor) and must reach every door (optionally every bed = interior reachability); plot-radius unchanged; decor unchanged; BUILDINGS `built` set → `{wall,floor,bedTile,shopTile}`, length 14.
- **`tests/world/world.test.ts`:** re-derive SOIL from `FIELD_RECT`, WATER from `WATER_POS`; replace `BUILDING={5,12}` with a house wall corner `{HOMESTEADS[0].house.x, .y}`; `width/height` via constants; `getTile(MAP_WIDTH,0)`/`(0,MAP_HEIGHT)`; pick guaranteed-interior tiles for `tilesInRadius`; isPassable: keep water/wall false, **replace `isPassable(building)===false`** with `isPassable(houseWallCorner)===false`, **ADD `isPassable(floorTile)===true`** (floorTile = `HOMESTEADS[0].door` or interior cell) — this asserts the OPPOSITE of before; till rejects wall (and add floor-not-tillable); landmark findPath unchanged; advanceDay crop tiles re-derived from `FIELD_RECT`.
- **`tests/qe/executor-matrix.test.ts`:** the inside-Dora's-house target (`{5,13}`, ~line 376) **FLIPS** from unreachable→reachable. Remove it from the impassable list; keep pond (from `WATER_POS`) + wall `{0,0}`. Add an "unreachable" case targeting a house **wall** corner. Optionally ADD: MOVE_TO an interior floor cell succeeds. Re-derive `{3,6}`/TALK_TO pair coords; confirm not inside a 5×5 footprint.
- **`tests/agents/executor.test.ts`:** introduce `STAND`/`TARGET` derived from `FIELD_RECT`; re-derive pond-interior `{31,10}` from `WATER_POS`; re-derive vertical-road TILL target; SHOP/BED via exports; confirm TALK_TO/MOVE_TO coords are passable/open.
- **`tests/agents/observation.test.ts`:** re-anchor the test agent + buddy near `HOMESTEADS[0]` so the 9×9 window is in-bounds (length 81) and the buddy stays in radius; landmark counts unchanged; farm tiles from `FIELD_RECT`; SHOP/BED via exports; confirm shop interior has no adjacent soil (no TILL).
- **`tests/agents/personas.test.ts`:** start-tile assertion **FLIPS `"path"`→`"floor"`** (line ~13). Other assertions derive from HOMESTEADS, auto-migrate.
- **`tests/agents/party-emergence.test.ts`:** re-derive `TAVERN_POS` from the tavern landmark. **HARD CONSTRAINT:** max(door→tavern A* path) ≤ 40 tiles (phase budget = `PHASE_DURATION_MS/WALK_MS_PER_TILE`=40). Place tavern door near map center (~x=33,y=20); nudge farthest homestead anchors inward until this test is green. **Run this test FIRST as the layout canary.**
- **`tests/agents/recurring-events.test.ts`:** `tavernPos` literals are local echoes into `buildGatheringEvent` (don't touch the map) — leave as-is (optional: re-derive from landmark).
- **`tests/world/pathfinding.test.ts`:** rewrite the straight-path/`from===to` cases to use the spine (`{x,y:20}`); re-derive water target + pond-flanking tiles from `POND`/`WATER_POS`; OOB `{99,6}` still OOB.
- **`tests/qe/economy-invariants.test.ts`:** SHOP via export; re-derive `{9,8}`/`{8,8}` from `FIELD_RECT`.
- **`tests/world/demo-loop.test.ts`:** re-derive plot tiles from `FIELD_RECT`.
- **`tests/world/render-mapping.test.ts`:** fence tests auto-migrate (constants); update stale "24x18" title; ADD non-negative assertions for new frame constants; keep bed-block/wall-row assertions.
- **`tests/agents/objects.test.ts`:** auto-migrates if WELL/BOARD keep the 1-east offset and `{5,5}` stays ≥5 tiles from every object (objects in the center). No edit if offsets preserved.
- **NEW tests (prove the feature; ≥7):** door-gap count per house (15 wall + 1 floor); interior reachability (BFS from tavern reaches every bed); floor passability; A* into a room (`findPath(spineTile, h.bed)` non-null, last==bed); tavern capacity ≥6 floor tiles; **zero `building` tiles remain**; every persona start passable.

## 8. File ownership (workstream A owns ONLY)
`contracts/types.ts`, `src/world/map.ts`, `src/world/Tile.ts`, `src/world/render.ts`, `src/scenes/WorldScene.ts`, `src/config.ts`, and ALL the existing tests listed in §7 + the new world/interior tests. Confirm `World.ts`/`Pathfinding.ts`/`Grid.ts` need NO change (read-through only). Does NOT touch `src/obs/**`, `src/scenes/UIScene.ts`, or any `src/agents/**` SOURCE (only `tests/agents/*` coordinate literals). `tests/agents/personas.test.ts` path→floor flip is owned here.

## 9. Risk register
1. **Missed hardcoded coordinate → red suite.** Mitigate: derive every literal; re-grep after.
2. **Tavern reachability >40 on bigger map.** Mitigate: central tavern; verify party-emergence FIRST; nudge anchors.
3. **Floor double-paint/depth glitch.** Mitigate: single-owner (tile layer owns floor/wall; paintInterior = furniture+sign).
4. **Door-gap not adjacent to a road → trapped interior + connectivity fail.** Mitigate: roads before rooms; door's outside neighbour is path (stub otherwise); interior-reachability test catches it.
5. **`Record<TileType>` non-exhaustive → build break.** Mitigate: add `floor` to `TILE_COLORS` with the union edit; `tsc --noEmit` immediately.

## 10. Build sequence
contract (`floor`, dims, `TILE_COLORS`) → `tsc` → `Tile.ts` PASSABLE → `map.ts` (stampRoom, HOMESTEADS, commons, BUILDINGS, exports; roads-before-rooms + stubs) → confirm Pathfinding/World/Grid unchanged → `render.ts` frames → `WorldScene` (floor/wall branch, trim paintInterior, confirm depth) → migrate §7 tests (party-emergence reachability FIRST) + add new tests → re-grep stray literals → full `vitest` ≥768 green + `tsc` clean → spot-check live render (assets + placeholder) shows agents walking into rooms.
