# Contract — Phase B-4: map-viewport overlays + selection wiring

Single source of truth for the implement agent AND verify critics. Adds the map
overlays (README §3): a context chip, a follow chip, a selected-agent pulse ring +
camera-follow, and a speech-bubble cap. Spans UIScene (chips + selection publish) and
WorldScene (pulse ring + follow + bubble cap). Builds on B-0 tokens.

NOTE: WorldScene/RenderApi has NO unit tests (Phaser render glue). Extract the
TESTABLE pure logic (bubble-cap policy) into a helper + unit-test it; the rest is
verified by the browser render. Determinism: these are render-only — do NOT touch the
sim, generateMap, or agent positions.

Run tools nvm-absolute: tests `node_modules/vitest/vitest.mjs run <f>` · full `node_modules/vitest/vitest.mjs run` · tsc `node_modules/typescript/bin/tsc --noEmit`.

## 1. Selection channel (UIScene → WorldScene)

- Add a registry key `REG_SELECTED` (define alongside `REG_HUD` in `src/obs/layout.ts`), value = the selected agent NAME or `null`.
- UIScene publishes it: set the name in `toggleTracePanel(name)` and clear it (`null`) in `closePanel()` (the same places `selectedAgent` is set/cleared). Additive to the existing `REG_HUD` publish.
- WorldScene reads it in `update()` to drive camera-follow + the pulse ring (below). It must coexist with the existing click-to-follow (a click-follow still works; selecting an agent in the HUD also follows it).

## 2. Context chip (UIScene, top-left of the map rect)

- A small chip pinned to the top-left INSIDE `hud.mapRect`: mono uppercase, a dark semi-opaque navy fill (`appBg`/`control` token at ~0.6 alpha), `borderControl` border, radius ~7. Text e.g. `MADOW VALLEY · 140×100` (use the real MAP_WIDTH×MAP_HEIGHT). (Backdrop-blur isn't feasible in Phaser — a semi-opaque fill is the accepted substitute; note it.)
- Drawn by UIScene (it owns HUD chrome + knows mapRect); positioned within the map region, repositioned on relayout.

## 3. Follow chip (UIScene, top-right of the map rect)

- Only visible when an agent is selected: `◎ Following · {name}`, white text, a brand-tinted semi-opaque fill (`brand600`/`brand400` at ~0.5 alpha), `brand400` border, radius ~7, `white-space:nowrap`. Pinned top-right inside `hud.mapRect`. Hidden when no selection.

## 4. Pulse ring + camera-follow (WorldScene, on the selected agent)

- When `REG_SELECTED` names an agent that exists on the map: draw a 2-ring pulse centered on that agent's sprite/container — inner stroke `brand400` (#5187F2), outer halo `brand400` at ~0.35 alpha — animated (gentle scale/alpha loop), depth just BELOW the agent so the sprite stays on top. Move/destroy it as selection changes (one ring at a time). Use the existing per-agent container; reuse the y-sort depth scheme.
- Camera-follow: when `REG_SELECTED` changes to an agent, `startFollow` that agent's container (reuse the existing follow machinery + `CAMERA_FOLLOW_LERP`); selecting null or a drag/pan releases it as today. Coexists with click-to-follow.

## 5. Speech-bubble cap (WorldScene)

- Cap concurrently-visible speech bubbles to the SELECTED agent's bubble + up to ~2 ambient (the most-recent other speakers). Extract a PURE policy helper (e.g. `src/obs/bubblePolicy.ts` → `visibleBubbleAgents(speaking: {name,t}[], selected: string|null, cap=3): string[]`) that, given the currently-speaking agents (with a recency key) + the selected name + a cap, returns which agents' bubbles should render (selected always included if speaking; then most-recent others up to the cap). Unit-test it (selected always kept; cap respected; ambient = most-recent; null-selected case). WorldScene's `showSpeech`/bubble bookkeeping consults the policy so a crowd can't stack into soup.
- The bubble still shows the 💬 emoji + emotion border as today (text stays in the panel) — only the COUNT is capped.

## Tokens

- All chip/ring colors come from theme.ts tokens (brand400/brand600/appBg/control/borderControl/white). If a genuinely new color is needed, ADD it to theme.ts + pin it; otherwise reuse. No hardcoded SpaceCon hex in UIScene/WorldScene for these.

## Tests

- New `tests/obs/bubblePolicy.test.ts` for the cap helper (teeth: selected kept, cap respected, ambient recency, null-selected).
- If a chip-text or world→screen helper is extracted as pure, unit-test it.
- `tests/obs/layout.test.ts`: only if you add a layout field for chip rects (optional — chips can be positioned inline from mapRect). If added, assert within mapRect, equal-or-greater strictness.
- WorldScene glue (pulse ring, follow, bubble draw) has no unit test — it is verified by the browser render (the orchestrator does this). Do NOT fabricate a fake test for it.

## Hard gates (verify must check ALL)

- Full suite green + `tsc --noEmit` clean.
- Render-only: the sim, `generateMap()` determinism, and agent positions are UNTOUCHED (no sim/world/contract change beyond the additive REG_SELECTED registry key + render). World determinism tests stay green.
- Selection wiring: selecting an agent (card/event-row click) publishes REG_SELECTED → WorldScene follows + rings it; deselect clears both. Click-to-follow still works.
- Bubble cap policy is correct + unit-tested (selected + ≤2 ambient).
- Tokens single-source (no new hardcoded SpaceCon hex); theme.ts values unchanged unless a pinned addition.
- No gamed gate: no unrelated assertion weakened; no fake WorldScene test.

## File ownership
A SINGLE implement agent owns: `src/scenes/UIScene.ts`, `src/scenes/WorldScene.ts`,
`src/obs/layout.ts` (REG_SELECTED + any chip rect), `src/obs/bubblePolicy.ts` (new),
`tests/obs/bubblePolicy.test.ts` (new), and `tests/obs/layout.test.ts` (only if a field
was added). Do NOT change the sim (`src/agents/`, `src/world/map.ts`), `config.ts`
world colors, or `src/obs/theme.ts` values (pinned additions only).
