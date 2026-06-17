# Richer World — A Town of Homesteads

- **Date:** 2026-06-16
- **Status:** Approved design, pre-implementation
- **Mission stage:** "get this bigger" — first chunk of Stage 3-adjacent world enrichment
- **Approach:** A (town of homesteads), chosen over B (zoned shared map) and
  C (contract-deep ownership). C is the planned fast-follow.

## Motivation

With the self-imposed budget ceilings removed (prior chunk), agents now stay
live instead of collapsing to the identical mock heuristic. But they still look
like clones, for a structural reason: the world has **one of everything** — one
`8×6` field, one bed, one shop, on a `24×18` map that is mostly empty grass.
This is exactly the anti-pattern the mission research flags (finding 13):

> action space so small the optimal move is obvious → a state machine would
> behave identically.

When six farmers share a single field and a single bed, every agent's optimal
move genuinely *is* "water the nearest crop," so they converge no matter how
distinct their personas are. The six personas already encode divergent intent
(Sage prioritizes socializing, Moss loves the pond, Dora/Gus/Fern each farm
differently) — they just have nowhere to enact it.

**This chunk gives them places to diverge on.** The key realization: divergence
emerges from *spatial layout* alone, with almost no new logic. Both the LLM and
the mock heuristic already act on the *nearest* crop/tile/landmark — so if each
agent lives next to its own plot and its own bed, it will tend its own plot and
sleep in its own bed without any ownership rules. We mostly need to lay out a
town and spread the agents across it.

## Goals

- Six agents visibly live in six different places, tend six independent plots,
  and converge on a shared town center to trade and socialize.
- Divergence works in **both** live and offline (mock) modes.
- The map reads as a populated farm town, not a dark empty field.
- Minimal contract churn; no executor/validation/prompt-structure changes.

## Non-goals (explicit fast-follows, not this chunk)

- New action verbs (forage, fish, chop, cook) — the "more things to do" chunk.
- Structured `home`/`plotRect` ownership on `Persona`/`Observation` with
  sleep-in-your-own-bed validation — approach C, a later chunk.
- Tiled/external map authoring — the map stays code-generated.

## Current state (what exists)

- `contracts/types.ts`: `MAP_WIDTH=24`, `MAP_HEIGHT=18`, `TILE_SIZE=32`,
  `OBSERVATION_RADIUS=4`. `TileType` = grass | path | water | tilled | soil |
  building | bedTile | shopTile | wall. `Landmark.kind` = shop | bed | water |
  house. 3 `CropKind`s. 12 `ActionType`s.
- `src/world/map.ts`: `generateMap()` builds the single-everything layout and
  returns `{ width, height, tiles, landmarks }`. Exports `BED_POS`, `SHOP_POS`,
  `HOUSE_POS`, `WATER_POS`, `FIELD_RECT`.
- `src/agents/personas.ts`: six personas, each with a `start` clustered at the
  one farmhouse door, plus `color` and `description`.
- `src/llm/mock.ts`: `findLandmark(obs, kind)` returns the **first** landmark of
  a kind (then falls back to the nearest visible tile). `nearest()` helper
  already exists and is used for crops/tiles.
- `src/agents/Observation.ts`: `landmarks` are global knowledge (every agent
  sees all of them); `nearby.tiles` is radius-4 around the agent. `SLEEP` is
  offered only when standing on a `bedTile` at night.
- `src/agents/ActionExecutor.ts`: `SLEEP` requires `here.type === "bedTile"` at
  night — already works for *any* bed (no ownership check), which is what we
  want for approach A.

## Design

### 1. Map: 24×18 → 48×32

Grow `MAP_WIDTH=48`, `MAP_HEIGHT=32` in `contracts/types.ts`. Wall/fence ring
unchanged in shape (it already derives from the constants). The fit-to-viewport
camera (`WorldScene.frameCamera`) already scales to any map size, so a larger
map "just works" visually (≈34px/tile at a typical spectator viewport); pan,
wheel-zoom, and click-to-follow remain available.

### 2. Central commons (map center)

A paved plaza joining the three shared destinations:

- **Shop** — one `building` with a `shopTile` entrance (`shop` landmark). BUY/SELL.
- **Tavern** — the social hub: a `building` footprint with an entrance tile,
  exposed as a **new `Landmark` kind `"tavern"`**. It is purely social — trade
  stays at the one shop — so personas gather here to TALK_TO / GIVE_GIFT / EMOTE.
- **Pond** — a `water` body, kept as the `water` landmark. It is scenery and
  Moss's spot; `WATER` is a field action that does not require sourcing from it,
  so the pond carries no mechanical dependency.

Paths radiate from the commons to every homestead so all of town is connected.

### 3. Homesteads (×6, one per persona)

Each homestead is a self-contained unit:

- A **house**: ~3×3 `building` footprint with exactly one `bedTile` on its door
  row (→ a `bed` landmark) and a `house` landmark on the path tile at the door.
- A **personal plot**: a ~4×3 block of `soil` adjacent to the house.
- A **path stub** connecting the homestead to the radiating path network.

Homesteads are spread to the four quadrants plus two mid-edges, assigned to
match persona flavor:

| Persona | Placement | Flavor hook |
|---|---|---|
| Diligent Dora | NW corner | runs a tidy, isolated operation |
| Grumbling Gus | NE corner | old-timer, set in his ways |
| Frugal Fern | SW corner | walks the long way, off on her own |
| Reckless Rusty | SE corner | far from the shop he overspends at |
| Social Sage | beside the tavern | wants to be where people pass |
| Moonstruck Moss | beside the pond | "the pond reflects the sky" |

### 4. Personas

- Each `start` moves to its own homestead's door tile (a walkable path tile
  adjacent to its bed and plot).
- One short **home/plot hint** sentence is appended to each `description`
  (e.g., Sage: "Your cottage sits beside the tavern." Moss: "Your plot
  overlooks the pond."). This grounds live planning. The existing mock keyword
  flavors ("reckless", "social", …) are preserved verbatim.

### 5. Mock heuristic fix

`findLandmark(obs, kind)` currently returns the *first* landmark of a kind. With
six beds this would send every offline agent to the same bed. Change it to pick
the **nearest** landmark of that kind (reusing the existing `nearest()` helper),
falling back to the nearest visible tile as today. Result: each offline agent
targets its own (nearest) bed/homestead, so divergence holds in mock mode too.
(Only one shop exists, so shop behavior is unchanged.)

### 6. Decor (visual life)

The generator emits a separate **`decor` list** (`{ kind, pos }[]`, e.g. tree /
flower / fence-post) placed on open grass, returned as a new optional field on
`MapData`. The renderer draws decor from the existing "trees" tileset asset
(already shipped per the asset manifest), depth-sorted below agents. Decor is
**non-interactive** — pure scenery, zero world logic — so it carries no
gameplay risk and is independently testable (count/placement bounds).

### 7. Contract changes (minimal)

- `MAP_WIDTH = 48`, `MAP_HEIGHT = 32` (`contracts/types.ts`).
- `Landmark.kind` gains `"tavern"` (`contracts/types.ts`).
- `MapData` gains optional `decor: { kind: string; pos: Vec2 }[]` — the
  `MapData` interface lives in `src/world/map.ts`, so this is a `map.ts` change.
- **No** structural change to `Observation`, `AgentAction`, `Persona` shape, or
  the action set. `Persona.start` values and `description` text change (data
  only). No OpenAPI/version bump (these are client-side TS-contract constants).

## Affected files

- `contracts/types.ts` — map dims, `Landmark.kind` adds `"tavern"`.
- `src/world/map.ts` — **the bulk**: the town generator (homesteads + commons +
  path network + decor) plus the `MapData.decor` field. `FIELD_RECT`/`BED_POS`/
  etc. exports re-derived or replaced with per-homestead structures.
- `src/agents/personas.ts` — start positions + home/plot hints.
- `src/llm/mock.ts` — `findLandmark` nearest-of-kind fix.
- `src/world/render.ts` (+ render mapping) — draw decor; confirm bigger-map
  rendering. *(Exact decor render mechanism to be confirmed during planning.)*
- `src/world/scriptedDemo.ts` — update its `FIELD_RECT` usage to a homestead plot.
- Tests — see below.

## Testing

- **Map invariants** (new): exactly 6 homesteads / 6 `bedTile`s / 6 personal
  plots; the tavern, shop, and pond exist; map is 48×32 with an intact wall
  ring; no overlapping footprints; all features within bounds.
- **Connectivity** (new): every homestead door is path-reachable (BFS over
  walkable tiles) from the tavern — no agent is stranded.
- **Per-agent start** (new): each persona's `start` is walkable, sits at its own
  homestead, and resolves to that homestead's bed as the *nearest* bed.
- **Mock heuristic** (update/extend): with multiple beds, `findLandmark`/the
  night routine targets the nearest bed; spatially separated agents pick
  distinct beds/plots.
- **Update hardcodes**: `tests/world/world.test.ts` (asserts 24/18 and
  out-of-bounds at 24/18) → new dims; `render-mapping.test.ts` already uses the
  constants (robust); fix the cosmetic "24x18" describe label.

## Risks & mitigations

- **Map too large to watch comfortably.** Mitigation: 48×32 fits a spectator
  viewport at ~34px/tile; pan/zoom/follow already exist. Tunable in one constant
  if it feels off in review.
- **LLM confused by six beds in the landmark list.** Mitigation: each agent
  knows its own position + a home hint in its persona; nearest-resolution covers
  mock. If live planning still wanders, the C fast-follow (explicit `home`)
  resolves it.
- **Decor render mechanism unknown.** Mitigation: decor is additive and
  isolated; if the trees tileset can't be placed arbitrarily, decor degrades to
  "omit" with zero impact on the behavioral goal. Confirmed during planning.
- **Pathfinding cost on a 4× map.** Mitigation: grid BFS over ~1.5k tiles is
  trivial; observation radius stays 4, so prompt size is unchanged.

## Resolved decisions (review, 2026-06-16)

- **Map size:** `48×32` — confirmed.
- **Social hub:** a **tavern** building (not a well/square). Purely social;
  trade is not duplicated there.
- **Trade:** a single shared **shop** in the commons (no second trade spot).
