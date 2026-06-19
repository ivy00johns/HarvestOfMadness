# Contract — Phase B-1: gathering body-spreading (render-only)

Single source of truth for the implement agent AND verify critics. When agents
converge on one tile (e.g. a gathering at the tavern), their sprites currently STACK
into a blob. This spreads their BODIES across a small cluster so a crowd reads as
distinct agents — **render-only, deterministic, zero sim change** (the last piece of
the README's "gathering legibility"; the font + bubble-cap halves already shipped).

Run tools nvm-absolute: tests `node_modules/vitest/vitest.mjs run <f>` · full `node_modules/vitest/vitest.mjs run` · tsc `node_modules/typescript/bin/tsc --noEmit`.

## Design (decided)

- **Render-only offset.** Agents keep their exact logical tile position (`agent.pos` — used by sim/pathfinding/tests is UNTOUCHED). Only the WorldScene sprite CONTAINER is visually nudged when it shares a tile with others, so they fan out around the tile center instead of overlapping.
- **Deterministic, no RNG/Date.** The offset is a pure function of (the agent's stable rank among the co-located set, the count). Sort the co-located agents by NAME for a stable, reproducible assignment; a single agent on a tile gets ZERO offset.
- Keep it subtle (a fraction of a tile) so agents stay clearly on their tile but don't perfectly overlap.

## Pure helper (extract + unit-test)

`src/obs/spread.ts` (pure, no Phaser):
- `spreadOffset(rank: number, count: number, radius: number): { dx: number; dy: number }` — deterministic placement of member `rank` of `count` around a ring (or center+ring for larger counts); `count<=1` → `{0,0}`. Even angular distribution: `angle = (rank/count)*2π` (+ a fixed phase). No RNG.
- (Optional) `spreadAssignments(names: string[], radius)` → `Map<name,{dx,dy}>`: sort names, assign each its `spreadOffset(rank,count,radius)`. Single name → `{0,0}`.
- Unit-test (`tests/obs/spread.test.ts`): count 1 → {0,0}; count N → N distinct offsets all within `radius` of center; deterministic (same input → same output, twice); sorted-by-name stable assignment; offsets roughly evenly distributed (no two identical for count≤8).

## WorldScene application (render-only)

- In WorldScene, group the live agent sprites by their current logical tile (rounded `agent.pos`). For any tile shared by ≥2 agents, apply `spreadAssignments` to nudge each container's RENDERED position to `tileCenter(pos) + {dx,dy}`; tiles with one agent get no offset.
- Apply it so it does NOT fight the walk tween: e.g. recompute on arrival / when the co-located set changes, or fold the offset into the container's resting position (a settled agent shows the offset; a walking agent tweens toward its spread resting spot). The exact hook is yours — but a walking agent must still animate smoothly and an idle crowd must visibly fan out. Keep the label de-collision (`restackLabels`) working.
- Determinism of the VISUAL is nice-to-have but the SIM determinism is mandatory: `agent.pos`, pathfinding, and all sim state stay byte-identical.

## Tests

- New `tests/obs/spread.test.ts` for the pure helper (teeth per above).
- WorldScene glue has no unit test (Phaser) — verified by the browser render (a gathering should show fanned-out bodies, not a blob). Do NOT fabricate a fake WorldScene test.

## Hard gates (verify must check ALL)

- Full suite green + `tsc --noEmit` clean.
- RENDER-ONLY: no change to `src/agents/`, `src/world/`, `generateMap`, `agent.pos`, or any sim/contract. World determinism tests stay green. The offset never feeds back into pathfinding or logical position.
- The spread helper is deterministic (no RNG/Date) and unit-tested with teeth.
- Tokens/colors unchanged (this is geometry, not color). theme.ts untouched.
- No gamed gate: no existing assertion weakened; no fake render test.

## File ownership
A SINGLE implement agent owns: `src/scenes/WorldScene.ts`, `src/obs/spread.ts` (new),
`tests/obs/spread.test.ts` (new). Do NOT change `src/agents/`, `src/world/`,
`config.ts`, `src/obs/theme.ts`, or any other scene/HUD file.
