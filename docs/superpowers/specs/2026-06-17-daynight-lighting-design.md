# Day/Night Ambient Lighting + Lit Lanterns — Implementation Spec

> Wave 3b. Pure render, no contract/logic change. Suite 834 green → **839 green + `tsc` clean**. Additive only; render-mapping.test.ts keeps every existing assertion.

## Ground truth
- `Phase` = morning|afternoon|evening|night (contracts/types.ts:54). `TimeSystem.onChange(cb)` (src/world/TimeSystem.ts:89) fires only on phase/day transitions (NOT per-frame); multiple subscribers OK (Set). Reach via `getTimeSystem()` (src/world/instance.ts) / `getWorld().time().phase`.
- Scenes `[BootScene, WorldScene, UIScene]` (main.ts) — UIScene is a SEPARATE scene/camera over WorldScene, so a WorldScene object CANNOT touch the HUD. WorldScene depths: BASE0/OVERLAY1/FACADE2/PROP3/OVERHEAD10000/BUBBLE20000; agents y-sort ~0–1300.
- decorations sheet key "decorations" (decorations-medieval.png, 512×2048, 16/row, 64 rows). Manifest: "Lanterns/torches cols 12-15". frame = row*16 + col (well frames confirm: RIM_L 208 = row13).
- config.ts is pure (no Phaser; holds TILE_COLORS/WATERED_TINT/EMOTION_STYLE). render.ts is pure (frame constants + mapping fns, unit-tested). BUILDINGS + WELL_POS/NOTICE_BOARD_POS/BENCH_POS in map.ts. Placeholder fallback: guard every asset draw with `textures.exists`.

## 1. Ambient tint — full-map overlay Rectangle (NOT camera tint, NOT per-tile)
- One `Phaser.GameObjects.Rectangle` (0,0)→(MAP_WIDTH*TILE_SIZE, MAP_HEIGHT*TILE_SIZE), origin(0,0), scrollFactor 1, at **`DEPTH_TINT = 9000`** (above world+agents, below trees 10000 / bubbles 20000 → those stay bright; HUD untouched as separate scene). Created once in `create()`.
- Why overlay not camera-tint: camera tint multiplies ALL world draws (washes sprites uncontrollably, uncappable). Overlay = one GPU quad, alpha-cappable so sprites stay legible.
- Palette in **config.ts** (pure, headless-testable):
  ```ts
  export interface PhaseTint { color: number; alpha: number; }
  export const PHASE_TINTS: Record<Phase, PhaseTint> = {
    morning:   { color: 0x9fb8d8, alpha: 0.12 },
    afternoon: { color: 0xffffff, alpha: 0.00 }, // midday no-op
    evening:   { color: 0xff9a3c, alpha: 0.22 }, // warm amber
    night:     { color: 0x1b2a55, alpha: 0.40 }, // cool blue, HARD CAP 0.40
  };
  export function phaseTint(phase: Phase): PhaseTint { return PHASE_TINTS[phase]; }
  export const PHASE_TINT_TWEEN_MS = 400;
  ```
  Extend the existing `import type {Emotion, TileType}` → add `Phase`. **Night alpha ≤ 0.40 is a hard rule** (legibility); labels use white+stroke3 so they survive the wash.
- Hook: in `create()`, `applyPhaseLighting(getWorld().time().phase, /*instant*/true)` then `this.unsubscribeTime = getTimeSystem().onChange(t => this.applyPhaseLighting(t.phase))`; unsubscribe in SHUTDOWN handler. Transition = 400ms tween of a `{t:0→1}` proxy interpolating color (Phaser.Display.Color.Interpolate.ColorWithColor) + linear alpha → `tintRect.setFillStyle`; on first/instant apply set directly (no tween).

## 2. Lanterns — render.ts + WorldScene
- `render.ts`: `LANTERN_FRAMES = { LIT: 12 + 16*2 /*=44, col12 row2*/, LIT_ALT: 13 + 16*2 /*=45, col13 row2*/ } as const;` adjacent pair (LIT_ALT−LIT===1), cols 12/13. (Row 2 is the one eyeball-confirm value; test pins only the col band + adjacency so a row tweak won't redden the suite.)
- `dressLanterns()` (WorldScene): early-return if `!useAssets || !textures.exists("decorations")`. Create `Image`s into `lanterns: Image[]`, `setOrigin(0.5,1)`, depth `DEPTH_TINT+1` (glow above the night wash), `setVisible(false)`. Placement: per `BUILDINGS` at the window column `windowX = b.doorX===b.x0 ? b.x1 : b.x0`, row `b.y1` (matches dressBuildings window logic) → 14 lanterns; + 3 at WELL_POS/NOTICE_BOARD_POS/BENCH_POS. ~17 total, created once.
- Toggle in `applyPhaseLighting`: `const lit = phase==="evening"||phase==="night"; for (l of lanterns) l.setVisible(lit);` (off morning/afternoon).

## 3. WorldScene changes (additive only)
Imports: from ../config add `PHASE_TINTS, phaseTint, PHASE_TINT_TWEEN_MS`; from ../world/render add `LANTERN_FRAMES`; from ../world/instance add `getTimeSystem`; from ../world/map add `WELL_POS, NOTICE_BOARD_POS, BENCH_POS`; `Phase` from contracts. New `const DEPTH_TINT = 9000`. New fields `tintRect`, `currentTint={color:0xffffff,alpha:0}`, `lanterns:Image[]=[]`, `unsubscribeTime`. In `create()` after dressWorldObjects: build tintRect, call `dressLanterns()`, `applyPhaseLighting(phase, true)`, subscribe; SHUTDOWN: `unsubscribeTime?.()`. Add `dressLanterns()` + `applyPhaseLighting(phase, instant=false)` methods (tween proxy; type the proxy explicitly so tsc is clean). NO change to drawTile*/paintInterior/paintFacade/RenderApi/camera/labels.

## 4. Tests (additive)
- `tests/world/render-mapping.test.ts`: import LANTERN_FRAMES; one new `it` in the existing "town props frame constants" describe — both ≥0, COL in [12,15], same ROW, LIT_ALT−LIT===1. Change NO existing assertion.
- NEW `tests/world/phase-lighting.test.ts` (pure, imports from ../../src/config): afternoon alpha===0; night alpha > evening and every phase alpha in [0,0.40]; evening red>blue, night blue>red; PHASE_TINTS has all 4 phases.
- Net 834 → 839. Existing render tests stay byte-identical green.

## 5. Ownership (Wave 3b owns)
`src/config.ts`, `src/world/render.ts`, `src/scenes/WorldScene.ts`, `tests/world/render-mapping.test.ts`, `tests/world/phase-lighting.test.ts`. READS ONLY (no edit): TimeSystem.ts, instance.ts, map.ts, contracts/types.ts (Phase type-import, no contract edit). Does NOT touch `src/agents/**`, `src/llm/**`, `server/**`, `src/obs/**`, `src/scenes/UIScene.ts` (other workstreams).

## 6. Risks
1. Wash-out → hard cap night α≤0.40 (test-enforced); labels white+stroke3; bubbles/trees above DEPTH_TINT stay bright. 2. Perf → event-driven only (≤4 tweens/day on 1 rect + ~17-elem setVisible); nothing per-frame. 3. Missing lantern frames → textures.exists guard, empty array no-op, tint still works. 4. Break render tests → additive only. 5. Tint on HUD → structurally impossible (separate scene/camera); DEPTH_TINT below trees/bubbles.
