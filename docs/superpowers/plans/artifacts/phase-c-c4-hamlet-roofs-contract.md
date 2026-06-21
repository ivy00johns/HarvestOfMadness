# Contract — Phase C · Slice C4: Per-hamlet roof/wall palette (visual identity)

**Branch:** `feat/phase-c-hamlet-roofs`
**Goal:** Give each of the five hamlets a distinct roof/wall **tint** so the four
corners (NW/NE/SW/SE) and the new central Greenhollow terrace read as different
neighborhoods at a glance — instead of every home sharing the same neutral
red-brick. **Render-only, zero sim/map/pathfinding change, deterministic.**

## Why this shape (from the render survey)

The primary render mode is the **open-roof cutaway** (`textures.exists("interior")`
→ `paintInterior`), so there is **no closed roof to tint** in the main view. A
house's visible color identity in cutaway mode is the **timber wall ring**, drawn
per-tile in `drawTileAssets`' `case "wall"` (`place(INTERIOR_WALL_TEXTURE, …)`,
which returns the `Phaser.GameObjects.Image`). So "roof palette per hamlet" is
delivered by **tinting the house wall ring per hamlet** (and, for the degraded
closed-facade fallback, tinting `paintFacade` for houses too).

`buildingStyle(kind)` stays as-is (kind→{tint,sign}); `house` keeps its neutral
`0xffffff` and the frozen `house tint is 0xffffff` test is untouched. The hamlet
tint is a **separate, position-derived** function applied at the render layer.

The two (and only) house color-identity sites:
1. **Primary (cutaway):** `drawTileAssets` `case "wall"` — currently applies NO
   tint. Add the hamlet tint for wall tiles inside a homestead footprint.
2. **Degraded (fallback):** `dressBuildings` line ~899 `buildingStyle(b.kind).tint`
   → for `kind === "house"`, use the hamlet tint instead of `0xffffff`.

## Files & changes

### 1. NEW pure module `src/obs/hamletStyle.ts` (no Phaser dependency)
```ts
export type Hamlet = "nw" | "ne" | "sw" | "se" | "central";

/** Per-hamlet roof/wall tint — gentle high-value washes multiplied onto the warm
 *  timber wall ring + red-brick facade, so the texture still reads through. */
export const HAMLET_ROOF_TINTS: Record<Hamlet, number> = {
  nw:      0xf2c9b8, // soft terracotta-red
  ne:      0xbfd2ec, // soft slate-blue
  sw:      0xefd9a8, // soft golden ochre
  se:      0xe0b8d0, // soft dusty rose
  central: 0xaee0d8, // soft teal-green (Greenhollow)
};

/** Classify a building CENTER (tile coords) into its hamlet by the Option-C
 *  geography: west corners x<50, east corners x>110, the central Greenhollow
 *  terrace between; north y<50, south y≥50. */
export function hamletOf(cx: number, cy: number): Hamlet { … }

export function hamletRoofTint(cx: number, cy: number): number {
  return HAMLET_ROOF_TINTS[hamletOf(cx, cy)];
}
```
- `hamletOf`: `const west = cx < 50, east = cx > 110;` → west ? (cy < 50 ? "nw" : "sw")
  : east ? (cy < 50 ? "ne" : "se") : "central". Pure, deterministic, zero RNG/Date.
- Exact hex values are NOT pinned by tests (so aesthetics can be tuned in the
  visual-verify step) — only **5-distinct + valid hex** is asserted.

### 2. `src/scenes/WorldScene.ts`
- Import `hamletRoofTint` (and `HOMESTEADS` if not already imported).
- Add a field `private houseWallTint = new Map<string, number>();`
- Build it ONCE (in `create()`, before tiles are drawn — or lazily on first
  draw): for each `h` of `HOMESTEADS`, compute the footprint center
  `(h.house.x + (h.size.w - 1) / 2, h.house.y + (h.size.h - 1) / 2)`, resolve
  `tint = hamletRoofTint(center)`, then for every `(x, y)` in the footprint rect
  `[h.house.x .. h.house.x + h.size.w - 1] × [h.house.y .. h.house.y + h.size.h - 1]`
  do `houseWallTint.set(\`${x},${y}\`, tint)`. (Covers the whole footprint; only
  the wall case looks it up, so only wall tiles get tinted — door-gap/interior
  floor cells are never queried. Civic walls aren't in HOMESTEADS → stay neutral.)
- In `drawTileAssets` `case "wall"` (the non-border branch): capture the placed
  image and tint it if the tile is a house wall:
  ```ts
  const img = this.textures.exists(INTERIOR_WALL_TEXTURE)
    ? place(INTERIOR_WALL_TEXTURE, INTERIOR_WALL_FRAME, DEPTH_FACADE)
    : place("interior", INTERIOR_FRAMES.WALL[x % INTERIOR_FRAMES.WALL.length], DEPTH_FACADE);
  const wallTint = this.houseWallTint.get(key);
  if (wallTint !== undefined) img.setTint(wallTint);
  ```
- In `dressBuildings` (degraded path, ~899): for `b.kind === "house"`, pass
  `tint: hamletRoofTint(centerOf(b))` to `paintFacade` instead of `style.tint`;
  civic kinds keep `style.tint`. (`centerOf(b)` = `(b.x0 + (b.x1 - b.x0) / 2,
  b.y0 + (b.y1 - b.y0) / 2)`.)

### 3. NEW test `tests/obs/hamletStyle.test.ts`
- Import `HOMESTEADS` + `hamletOf`/`HAMLET_ROOF_TINTS`/`hamletRoofTint`.
- **Classification teeth:** for all 15 homes, `hamletOf(center)` equals the
  expected hamlet — brix/ford/wren→nw, dora/gus/clem→ne, fern/nell/sage→sw,
  rusty/moss/zola→se, juno/pim/odo→central. (This pins the boundaries against
  the real coords; a future home that lands in the wrong band trips here.)
- **Cohesion:** the 3 homes in each hamlet resolve to ONE shared tint.
- **Identity:** the 5 hamlets yield 5 DISTINCT tints, all valid hex (0..0xffffff).
- **Determinism:** `hamletRoofTint` is pure (same input → same output; no
  RNG/Date in the module source).

## Determinism & invariants — MUST hold (tests are the source of truth)
- **Zero `Math.random` / zero `Date`** — pure classifier + static palette + a
  deterministically-built tile map (iterate HOMESTEADS in order).
- **Full suite green** (`node_modules/vitest/vitest.mjs run`, currently 1253) —
  no existing assertion changes. Specifically preserve:
  - `buildingStyle.test.ts`: untouched — `buildingStyle("house")` still 0xffffff,
    kind tints/signs unchanged (the hamlet tint is a SEPARATE function).
  - `map.test.ts` / all sim tests: no map/sim/pathfinding change whatsoever.
- `node_modules/typescript/bin/tsc --noEmit` clean.
- **No map-data, persona, or sim change** — this slice touches only `src/obs/`
  (new module) and `src/scenes/WorldScene.ts` (render) + the new test.

## Visual verification (REQUIRED — the suite cannot see a tint)
Headless tests prove the classifier + palette logic but NOT the render wiring
(Phaser, untested). After the gate, **load the dev UI and confirm** the five
hamlets show visibly distinct house colors (NW terracotta / NE slate-blue / SW
ochre / SE rose / central Greenhollow teal), the texture still reads through the
wash, and civic buildings are unaffected. Use a Playwright screenshot via a
cheap-model subagent (text-only return) per the project's established pattern.
If a tint reads muddy/garish, tune the hex in `HAMLET_ROOF_TINTS` (tests assert
distinctness, not exact values).

## Out of scope (explicit)
- Per-hamlet SIGN emojis or roof SPRITES (color/tint only this slice).
- Tinting civic buildings, fences, decor, or crops.
- Any new roof geometry/eave element in the cutaway view.
- Adding a `hamlet` field to `HomesteadSpec`/`BuildingFootprint` (position-derived
  keeps it render-only and data-shape-stable).
- North Star doc update + commit — orchestrator does these after the gate.

## POST-VERIFY STRENGTHENING (visual loop, user-directed)

The wall-ring-only gentle wash shipped correct + deterministic but visual
verification (live dev server) showed it too **subtle** to read "at a glance" —
the thin 1-tile ring is a small fraction of each cutaway house, and high-value
washes barely shift the warm timber. Per the user's call ("strengthen — floors +
walls, bolder"):
- Also tint the house **floor** (the large interior area) per hamlet — the
  `drawTileAssets` `floor`/`bedTile`/`shopTile` case now looks up the same
  precomputed map (renamed `houseTileTint` / `buildHouseTileTints`). Civic floors
  aren't in `HOMESTEADS` → no key → stay neutral (verified live: downtown civic
  rooms render neutral). `shopTile` is civic-only → untinted.
- **Bolder palette** (more chroma): nw `0xe49873`, ne `0x8fb4e0`, sw `0xe6c259`,
  se `0xd58cbe`, central `0x6fceb6`. Still 5 distinct valid hex (test unchanged).
- Re-verified: 1259 green, tsc clean, deterministic; live full-map shows five
  distinctly-colored clusters at a glance, tasteful (muted wood washes), civic
  neutral. Same wiring-correctness properties as the wall-ring pass (same key set).
