# World Dressing & Map Expansion — Visual Richness Pass

- **Date:** 2026-06-17
- **Branch:** `feat/world-dressing` (worktree, off `8cfb16d`)
- **Status:** Design approved — pending spec review (revised to add map expansion)
- **Related:** runs in parallel with the Governance v1 work on `feat/richer-world` (no file overlap)

## Goal

Close the visual gap between Harvest of Madness and Stanford's Generative Agents
("Smallville") reference screenshots. The town should read as a lush, densely
decorated, appropriately-sized world rather than a compact patch of flat green
grass on a rigid grey grid.

**Key framing — this is a renderer gap, not an asset gap.** HOM already ships a
broader free LPC (OpenGameArt, CC-BY-SA) asset library than Smallville's
commercial packs, and the agent-overlay UI (speech bubbles, emoji pronunciatio,
plan labels, emote particles) is already at or beyond Smallville parity. The
deficit is in two dimensions:

1. **Map extent** — HOM is **64×40**; Smallville is **140×100** (same 32px tiles),
   which is why theirs reads as a sprawling, districted town and ours feels compact.
2. **Decoration density** — terrain variety, decorative scatter, organic paths,
   interior density, building structure.

This pass addresses both: a moderate enlargement to **~96×64** sized for **~25
agents**, plus the density work.

## Non-Goals

- **Do not rebuild the agent-overlay UI.** `showSpeech`, `setActivityEmoji`,
  `setActivityLabel`, `playEmote`, name de-collision already exist and work.
- **Do not clone the paper's callout cards** ("Taking a walk in the park", etc.).
  Those are figure annotations from the Generative Agents paper, not the live UI.
- **No engine swap and no full Phaser `TilemapLayer` migration.** We keep the
  existing Phaser scene structure and the pure `render.ts` frame-logic core.
- **No agent-count or agent-behavior changes here.** Map *extent and building
  layout* are in scope (that's `map.ts`); the *number of agents and their personas*
  live in the agents layer (the other session) and are out of scope. The expanded
  map exposes residential capacity for ~25 agents; the agents layer fills it.

## Constraints (hard)

1. **Determinism / zero RNG.** The map generator and all placement must remain
   fully deterministic. New scatter/variety/layout uses coprime hashing
   `(x*p + y*q + salt) % n` keyed on tile coordinates — never `Math.random` or
   `Date` (both unavailable in this codebase by design). Same inputs → byte-identical
   map and decoration on every run. Existing determinism tests must stay green; new
   ones are added.
2. **Isolation from the governance session.** Touch only the world-rendering
   subsystem. Files in scope: `src/scenes/WorldScene.ts`, `src/world/map.ts`,
   `src/world/render.ts`, `public/assets/manifest.json`, `src/config.ts`,
   `public/assets/CREDITS.md`, plus new asset files and new tests. Explicitly
   **out of bounds** (owned by governance): `src/scenes/UIScene.ts`,
   `src/obs/activityEmoji.ts`, `src/obs/wiring.ts`, `contracts/*`, and all
   `src/agents/*` files.
3. **Agent-layer integration point (read-only).** The expanded map exposes
   residential bed-slots and spawn points via its landmark list. If the agents layer
   already consumes that list dynamically, no coordination is needed beyond adding
   personas. If it hardcodes a 12-home/12-agent assumption, this spec **flags it for
   the other session** rather than editing any `src/agents/*` file.
4. **Free assets only.** Reuse repo assets first. Any supplementary art must be
   free CC-BY-SA (or compatible) LPC from OpenGameArt, logged in `CREDITS.md` and
   `manifest.json`. Zero dollars.
5. **No visual regression to the agent overlays or HUD chrome.**

## Architecture — Approach A: Layered RenderTexture pipeline

Today every tile is an individual `Phaser.GameObjects.Image` (~2,560 sprites for
the 64×40 map; ~6,100 at 96×64), placed by `WorldScene.drawTileAssets(x, y)`. Dense
scatter on a larger map would add many thousands more live sprites. We introduce
explicit baked layers so static content costs ~one texture instead of thousands of
sprites.

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

Each phase is independently shippable and reviewable, ordered foundation → extent →
density.

### Phase 0 — RenderTexture base refactor (foundation, no visual change)
Move the static ground off per-tile `Image`s into the L0 `RenderTexture`, verified on
the **current 64×40 map** so we have a clean golden baseline. Dynamic overlays (crops,
water animation, agents) stay exactly as-is. Output must be visually identical to
today. Gated by a tile-count / live-sprite-count assertion so we prove nothing
regressed before changing dimensions or adding richness.
- Files: `WorldScene.ts` (`buildBaseLayer`, `drawTile`, `drawTileAssets`).

### Phase 1 — Map expansion to ~96×64 (sized for ~25 agents)
Grow the world from 64×40 to ~96×64 and re-author the layout for ~25 residential
slots plus more distinct districts (additional homestead rows, a larger downtown
civic cluster, an expanded park, extended road network). Stays fully deterministic
(zero RNG) and fully connected (every door reaches a road; every building reachable
via A*). Sized so the existing 12 agents still feel present while exposing capacity
for ~25.
- **Integration:** verify the agents layer assigns homes/spawns from the map's
  landmark list dynamically. This phase changes only `map.ts`; if a hardcoded 12-home
  assumption exists in `src/agents/*`, flag it for the other session (do not edit).
- Files: `src/world/map.ts` (`MAP_WIDTH`/`MAP_HEIGHT`, `generateMap`, `HOMESTEADS[]`,
  `COMMONS[]`, `ROAD_SEGMENTS[]`), `src/config.ts` if dimensions live there.
- Acceptance: deterministic output; connectivity invariant holds; ≥25 reachable
  bed-slots exposed; existing pathfinding/economy tests stay green.

### Phase 2 — Terrain variety + autotile transitions
Expand grass frame variety; add soft grass↔path / grass↔water / grass↔soil edge
transitions using `terrain.png`'s built-in transition sets. Replaces hard
rectangular edges.
- Files: `render.ts` (new transition mask→frame fns + tests), `WorldScene.ts`.

### Phase 3 — Organic dirt paths
Replace rigid grey cobble (frames 48/50) with autotiled dirt/sand paths plus grassy
borders, using the `PathAndObjects.png` autotile path islands already loaded but
unused.
- Files: `render.ts` (path autotile fn + tests), `WorldScene.ts`, possibly
  `map.ts` if path widths change.

### Phase 4 — Decorative ground scatter
Deterministic scatter of flowers, bushes, tall grass, rocks, and ground clutter into
L1, density-tunable. The single biggest visual jump. Scatter avoids occupied tiles
(buildings, roads, water, soil) and respects a configurable density.
- Files: `render.ts` (scatter selection fn + tests), `WorldScene.ts`, `map.ts`
  (eligibility masks), `manifest.json`, possibly new CC-BY-SA decoration sheet.

### Phase 5 — Foliage density
Replace the lone scattered trees with clustered trees and forest edges along the map
border / park, deterministic and tunable.
- Files: `map.ts` (tree scatter), `WorldScene.ts` (`dressTrees`, `dressPark`).

### Phase 6 — Denser interiors
Per-building-kind furniture lists go from 4–5 → 8–12 pieces (shelves with items,
rugs, plants, kitchen/hearth, varied seating). Replace the harsh checkerboard floor
with a warmer wood/tile floor.
- Files: `WorldScene.ts` (`paintInterior`), `manifest.json` if new furniture frames.

### Phase 7 — Building structure
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
so density is dial-able without code edits. Map dimensions also live as named
constants for easy adjustment.

## Testing Strategy

- **Unit (`render.ts`):** autotile mask → frame mapping for grass/path/water/soil
  transitions; scatter selection determinism and eligibility.
- **Map (`map.ts`):** deterministic generation; full connectivity (every door
  reachable via A*); ≥25 residential bed-slots exposed at the new size.
- **Determinism:** same generated map → identical decoration placement (extend the
  qe determinism suite).
- **Performance guard:** assert static layers are baked — bound the live-sprite
  count so the larger, denser version cannot silently regress to many thousands of
  sprites.
- **No-regression:** existing 933-test baseline stays green.
- **Visual:** before/after Playwright screenshot via a cheap-model (haiku/sonnet)
  subagent that returns a text description only, per the project's usual setup.

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Map expansion breaks connectivity (unreachable building) | Preserve the "roads first" generation invariant; add an A* reachability test (every door reaches every other) |
| Bigger map feels empty | Size districts for ~25 agents and coordinate count with the agents session; fall back to fewer/fuller districts |
| Hardcoded 12-home assumption in the agents layer | Verify home-assignment reads the map landmark list dynamically; flag (don't edit) if hardcoded |
| Roof strip occludes agents on tiles above a building (y-sort artifact) | Use only a thin roof-edge strip; depth-cull it when an agent is adjacent (Phase 7) |
| RenderTexture refactor regresses dynamic redraw (crops/water) | Phase 0 keeps all dynamic overlays as live sprites; only static tiles move to the RT; gated by golden/sprite-count test |
| Determinism break from new scatter/layout | Coprime hashing only; unit + determinism tests gate every phase |
| Missing decoration art | Fall back to existing sheets; add free LPC only when a real gap appears |
| Larger map worsens per-tile sprite cost | Mitigated by the Phase 0 RT refactor, done before expansion |
| Merge friction with governance | Disjoint file set; branch off the shared commit `8cfb16d` |

## Git / Isolation Plan

Work entirely in the worktree at `/Users/johns/Projects/HOM-world-dressing` on
`feat/world-dressing`, branched off `8cfb16d` (pre-governance), giving a pure
visual-only diff. Touch only the in-scope files listed under Constraints. Integration
order (governance vs. visual, and target branch) is the user's call at finish time;
the disjoint file sets merge cleanly either way.

## Out of Scope / Future

- Growing the map all the way to Smallville's 140×100; agent-count/persona changes.
- Weather, seasons, and time-of-day terrain changes beyond existing lighting.
- Animated decoration (swaying grass, particle ambience).
- A real Tiled `.tmx` authoring pipeline.
- Packed-atlas tileset build step / full `TilemapLayer` migration.
