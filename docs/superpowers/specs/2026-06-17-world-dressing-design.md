# World Dressing — Visual Richness Pass

- **Date:** 2026-06-17
- **Branch:** `feat/world-dressing` (worktree, off `8cfb16d`)
- **Status:** Design approved — pending spec review
- **Related:** runs in parallel with the Governance v1 work on `feat/richer-world` (no file overlap)

## Goal

Close the visual gap between Harvest of Madness and Stanford's Generative Agents
("Smallville") reference screenshots. The town should read as a lush, densely
decorated world rather than flat green grass on a rigid grey grid.

**Key framing — this is a renderer gap, not an asset gap.** HOM already ships a
broader free LPC (OpenGameArt, CC-BY-SA) asset library than Smallville's
commercial packs, and the agent-overlay UI (speech bubbles, emoji pronunciatio,
plan labels, emote particles) is already at or beyond Smallville parity. The
deficit is entirely in **how densely the existing art is placed**: terrain
variety, decorative scatter, organic paths, interior density, and building
structure.

## Non-Goals

- **Do not rebuild the agent-overlay UI.** `showSpeech`, `setActivityEmoji`,
  `setActivityLabel`, `playEmote`, name de-collision already exist and work.
- **Do not clone the paper's callout cards** ("Taking a walk in the park", etc.).
  Those are figure annotations from the Generative Agents paper, not the live UI.
- **No engine swap and no full Phaser `TilemapLayer` migration.** We keep the
  existing Phaser scene structure and the pure `render.ts` frame-logic core.
- **No new gameplay/agent behavior.** Visual rendering only.

## Constraints (hard)

1. **Determinism / zero RNG.** The map generator and all placement must remain
   fully deterministic. New scatter/variety uses coprime hashing
   `(x*p + y*q + salt) % n` keyed on tile coordinates — never `Math.random` or
   `Date` (both unavailable in this codebase by design). Same map → byte-identical
   decoration on every run. Existing determinism tests must stay green; new ones
   are added.
2. **Isolation from the governance session.** Touch only the world-rendering
   subsystem. Files in scope: `src/scenes/WorldScene.ts`, `src/world/map.ts`,
   `src/world/render.ts`, `public/assets/manifest.json`, `src/config.ts`,
   `public/assets/CREDITS.md`, plus new asset files and new tests. Explicitly
   **out of bounds** (owned by governance): `src/scenes/UIScene.ts`,
   `src/obs/activityEmoji.ts`, `src/obs/wiring.ts`, `contracts/*`, and all
   `src/agents/*` files.
3. **Free assets only.** Reuse repo assets first. Any supplementary art must be
   free CC-BY-SA (or compatible) LPC from OpenGameArt, logged in `CREDITS.md` and
   `manifest.json`. Zero dollars.
4. **No visual regression to the agent overlays or HUD chrome.**

## Architecture — Approach A: Layered RenderTexture pipeline

Today every tile is an individual `Phaser.GameObjects.Image` (~2,560 sprites for
the 64×40 map), placed by `WorldScene.drawTileAssets(x, y)`. Dense scatter would
add thousands more live sprites. We introduce explicit baked layers so static
content costs ~one texture instead of thousands of sprites.

| Layer | Contents | Lifetime | Mechanism |
| --- | --- | --- | --- |
| **L0 Static ground** | grass variants, grass↔path/water/soil autotile transitions, organic dirt paths | baked once at world build; re-baked only on terrain edits | `RenderTexture` |
| **L1 Static decoration** | deterministic scatter (flowers, bushes, tall grass, rocks, ground clutter); clustered trees / forest edges | baked once | `RenderTexture` |
| **L2 Building shells** | wall ring + thin roof-edge strip + warm floor; densified interior furniture | baked once (furniture may remain sprites where simpler) | `RenderTexture` + sprites |
| **L3 Dynamic** | crops growing, water animation, agents, speech bubbles, emotes, day/night light overlay | live every frame, unchanged | existing sprites |

**Pure logic stays in `src/world/render.ts`** (no Phaser dependency, unit-testable):
expanded frame tables plus autotile/scatter selection functions. `WorldScene` only
blits what `render.ts` decides. This keeps the richness logic testable in isolation
and keeps `WorldScene` a thin renderer.

## Implementation Phases

Each phase is independently shippable and reviewable, ordered by risk then ROI.

### Phase 0 — RenderTexture base refactor (foundation, no visual change)
Move the static ground off per-tile `Image`s into the L0 `RenderTexture`. Dynamic
overlays (crops, water animation, agents) stay exactly as-is. Output must be
visually identical to today. Gated by a tile-count / live-sprite-count assertion so
we prove nothing regressed before adding richness.
- Files: `WorldScene.ts` (`buildBaseLayer`, `drawTile`, `drawTileAssets`).

### Phase 1 — Terrain variety + autotile transitions (#2)
Expand grass frame variety; add soft grass↔path / grass↔water / grass↔soil edge
transitions using `terrain.png`'s built-in transition sets. Replaces hard
rectangular edges.
- Files: `render.ts` (new transition mask→frame fns + tests), `WorldScene.ts`.

### Phase 2 — Organic dirt paths (#3)
Replace rigid grey cobble (frames 48/50) with autotiled dirt/sand paths plus grassy
borders, using the `PathAndObjects.png` autotile path islands already loaded but
unused.
- Files: `render.ts` (path autotile fn + tests), `WorldScene.ts`, possibly
  `map.ts` if path widths change.

### Phase 3 — Decorative ground scatter (#1)
Deterministic scatter of flowers, bushes, tall grass, rocks, and ground clutter into
L1, density-tunable. The single biggest visual jump. Scatter avoids occupied tiles
(buildings, roads, water, soil) and respects a configurable density.
- Files: `render.ts` (scatter selection fn + tests), `WorldScene.ts`, `map.ts`
  (eligibility masks), `manifest.json`, possibly new CC-BY-SA decoration sheet.

### Phase 4 — Foliage density (#6)
Replace the ~16 lone trees with clustered trees and forest edges along the map
border / park, deterministic and tunable.
- Files: `map.ts` (tree scatter), `WorldScene.ts` (`dressTrees`, `dressPark`).

### Phase 5 — Denser interiors (#4)
Per-building-kind furniture lists go from 4–5 → 8–12 pieces (shelves with items,
rugs, plants, kitchen/hearth, varied seating). Replace the harsh checkerboard floor
with a warmer wood/tile floor.
- Files: `WorldScene.ts` (`paintInterior`), `manifest.json` if new furniture frames.

### Phase 6 — Building structure (#5)
Wall-ring polish plus a thin roof-edge strip so rooms read as buildings. Handle
agent occlusion: depth-cull the roof strip when an agent is on an adjacent tile, so
roofs never hide agents.
- Files: `WorldScene.ts` (`paintInterior`/`paintFacade`, depth handling),
  `manifest.json` if roof frames are added.

## Asset Policy

Reuse existing repo art first: `terrain.png` transition sets, `plants.png`,
`tallgrass.png`, `reed.png`, `decorations-medieval`, the four furniture sets, the
modular walls/roofs/windows-doors, and victorian/roman sets. Where a specific
decoration is genuinely missing (e.g. dedicated flower tiles), pull a supplementary
free CC-BY-SA LPC sheet from OpenGameArt and record it in `CREDITS.md` and
`manifest.json`.

## Tunability

Add density knobs to `src/config.ts` (`scatterDensity`, `treeDensity`,
`foliageClustering`, interior-density level) defaulting to a Smallville-ish lushness,
so density is dial-able without code edits.

## Testing Strategy

- **Unit (`render.ts`):** autotile mask → frame mapping for grass/path/water/soil
  transitions; scatter selection determinism and eligibility.
- **Determinism:** same generated map → identical decoration placement (extend the
  qe determinism suite).
- **Performance guard:** assert static layers are baked — bound the live-sprite
  count so the dense version cannot silently regress to thousands of sprites.
- **No-regression:** existing 933-test baseline stays green.
- **Visual:** before/after Playwright screenshot via a cheap-model (haiku/sonnet)
  subagent that returns a text description only, per the project's usual setup.

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Roof strip occludes agents on tiles above a building (y-sort artifact) | Use only a thin roof-edge strip; depth-cull it when an agent is adjacent (Phase 6) |
| RenderTexture refactor regresses dynamic redraw (crops/water) | Phase 0 keeps all dynamic overlays as live sprites; only static tiles move to the RT; gated by golden/sprite-count test |
| Determinism break from new scatter | Coprime hashing only; unit + determinism tests gate every phase |
| Missing decoration art | Fall back to existing sheets; add free LPC only when a real gap appears |
| Merge friction with governance | Disjoint file set; branch off the shared commit `8cfb16d` |

## Git / Isolation Plan

Work entirely in the worktree at `/Users/johns/Projects/HOM-world-dressing` on
`feat/world-dressing`, branched off `8cfb16d` (pre-governance), giving a pure
visual-only diff. Touch only the in-scope files listed under Constraints. Integration
order (governance vs. visual, and target branch) is the user's call at finish time;
the disjoint file sets merge cleanly either way.

## Out of Scope / Future

- Weather, seasons, and time-of-day terrain changes beyond existing lighting.
- Animated decoration (swaying grass, particle ambience).
- A real Tiled `.tmx` authoring pipeline.
- Packed-atlas tileset build step / full `TilemapLayer` migration.
