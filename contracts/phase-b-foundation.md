# Contract — Phase B-0: SpaceCon design-token + font foundation

Single source of truth for the implement agent AND the verify critics. The
FOUNDATION slice of the SpaceCon HUD overhaul (`docs/design_handoff_sim_hud/README.md`,
§Design Tokens). Introduces the design-token module, loads the SpaceCon fonts, and
**rethemes the existing HUD to the navy palette with NO structural change** — same
regions, same layout math, same behavior. Pure look swap + the token substrate every
later Phase B slice consumes.

Run tools with nvm-absolute node:
- tests: `node_modules/vitest/vitest.mjs run <file>` · full: `node_modules/vitest/vitest.mjs run`
- tsc: `node_modules/typescript/bin/tsc --noEmit`

---

## Design (decided — do not re-litigate)

- The HUD stays **pure Phaser** (no DOM/React overlay) — follow the existing approach.
- A new **`src/obs/theme.ts`** is the single source of HUD color + type tokens.
- Retheme with MINIMAL churn: **redefine the existing `COLOR_*` / `FSM_COLORS` constants in `UIScene.ts` and `BACKGROUND_COLOR` in `config.ts` to source their values from `theme.ts`** — keep the constant NAMES so every existing usage automatically picks up the new palette. No region/layout/behavior change this slice.
- Structural pieces (command bar, KPI band, cards, rail, overlays) are LATER slices — out of scope here.

## Exact token values (from README §Design Tokens — pin these verbatim)

`src/obs/theme.ts` exports the SpaceCon tokens. Provide BOTH number form (`0xRRGGBB`,
for Phaser `fillStyle`/`lineStyle`/Rectangle) and string form (`#RRGGBB`, for Phaser
text-style `color`). Group + name semantically.

**Surfaces / neutrals**
- appBg `#0B1220` · mapBg `#0d1626` · cmdGradTop `#10192b` · cmdGradBot `#0d1424`
- card `#111c30` · cardSelected `#15233c` · insetTile `#0d1626` · control `#0c1424`
- borderCard `#1f2c46` · borderControl `#24324d` · borderInspector `#2f4a6b` · divider `#1c2840`
- white `#FFFFFF` · ink300 `#A7B0C0` (body) · ink400 `#76839B` (labels) · ink500 `#51607C` (faint)

**Brand / accents**
- brand600 `#1E50C8` · brand500 `#2A63E0` · brand400 `#5187F2`
- cyan500 `#2AA9D6` · cyan300 `#7FD3EC` · positive500 `#18996F` · p2 (amber) `#D9892B` · p1 (red) `#D64550` · statusDecision (violet) `#6A4BC2`

**Semantic tints** (badge fills — `{ color, alpha: 0.16 }`)
- exec `{0x137E5C, .16}` · think `{0xB9760F, .16}` · idle `{0x51607C, .16}` · reflect `{0x2AA9D6, .16}` · plan `{0x1E50C8, .16}` · obsTag fill `0x1F2C46`

**Type** — font-family stacks
- `FONT_DISPLAY = "'Space Grotesk', ui-sans-serif, system-ui, sans-serif"` (names, numbers, titles, headers)
- `FONT_BODY = "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif"` (goals, thought/quote, persona, chat)
- `FONT_MONO = "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace"` (labels, telemetry, IDs, badges)

**Radius** — `{ control: 8, card: 13, badge: 5, bar: 4 }` (for later slices; export now).

## Retheme map (redefine existing constants from tokens — semantic, not literal)

In `src/scenes/UIScene.ts` redefine, sourcing values from `theme.ts`:
- `COLOR_TEXT` → white · `COLOR_DIM` → ink300 · `COLOR_FAINT` → ink400/ink500 (faint meta) · `COLOR_HEADER` → ink400 (mono labels)
- `COLOR_GOLD` → p2 (amber) · `COLOR_GOAL` (the one accent) → cyan300 · `COLOR_PLAN` → brand400 · `COLOR_OK` → positive500 · `COLOR_BAD` → p1
- `COLOR_CHROME` → card surface · `COLOR_CARD_BG` → card (and use cardSelected for the selected card if a selected style exists) · `COLOR_BORDER` → borderCard
- `FSM_COLORS`: IDLE → ink400 · THINKING → p2 (amber) · EXECUTING → positive500 (matches the design's exec/think/idle state colors)

In `src/config.ts`: `BACKGROUND_COLOR` → appBg (`#0B1220`). Leave `TILE_COLORS`, `CROP_COLORS`, `EMOTION_STYLE`, `PHASE_TINTS` UNTOUCHED — those are WORLD rendering, not HUD chrome.

In `src/obs/layout.ts`: point `HUD_FONT` at `FONT_DISPLAY`, `MONO_FONT` at `FONT_MONO`, and export/wire `HUD_FONT_BODY = FONT_BODY`. Keep `FONT_SIZE_*` values (≥12 — contract rule 14). Apply `HUD_FONT_BODY` to the prose text styles in UIScene (goal, thought/quote, persona, chat/transcript) — these are the "fix the terrible font" body strings; names/numbers/labels stay on display/mono.

## Font loading

- `index.html`: add Google Fonts `<link>` (preconnect + the css2 bundle) for **Space Grotesk** (400;600;700), **IBM Plex Sans** (400;500;600), **IBM Plex Mono** (400;500;600), `display=swap`.
- Ensure Phaser text is measured AFTER the fonts load (web fonts load async; Phaser measures glyphs at text creation). In `src/main.ts`, before `new Phaser.Game(...)`, await font readiness with a guarded timeout, e.g.:
  ```ts
  if (typeof document !== "undefined" && (document as any).fonts?.ready) {
    await Promise.race([ (document as any).fonts.ready, new Promise((r) => setTimeout(r, 1500)) ]);
  }
  ```
  (Guard for `document.fonts` absence so non-browser/test contexts don't break. A late-load relayout is an acceptable alternative if cleaner — but text must end up measured with the real font.)

## Tests

- **New `tests/obs/theme.test.ts`** — pin every token to its documented value (number AND string form), assert the three font stacks name Space Grotesk / IBM Plex Sans / IBM Plex Mono first, and assert the tint alphas are 0.16. This locks the palette so later slices can't silently drift.
- Keep `tests/obs/layout.test.ts` GREEN (font constants stay strings; FONT_SIZE_* ≥12 unchanged; region math untouched). If it imports the old font constant names, keep those names exported (re-pointed values).
- The font-ready wait must NOT break the (node/jsdom) test env — guard `document.fonts`.

## Hard gates (verify must check ALL)

- Full suite green (existing 1097 + new theme cases) + `tsc --noEmit` clean.
- **No structural change**: `computeHud` region math, hit-testing, and all `HudLayout` fields are byte-unchanged; `layout.test.ts` passes WITHOUT edits (or only additive). The HUD's regions/behavior are identical — only colors + fonts changed.
- Single source: no SpaceCon hex is hardcoded outside `theme.ts`; the `COLOR_*`/`FSM_COLORS`/`BACKGROUND_COLOR` constants derive from it.
- World rendering untouched: `TILE_COLORS`/`CROP_COLORS`/`EMOTION_STYLE`/`PHASE_TINTS` and `generateMap()` unchanged; determinism intact.
- No gamed gate: do not weaken any assertion; if an existing test genuinely asserted an old color value, that's a real update (record it), but none is expected.

## File ownership
A SINGLE implement agent owns: `src/obs/theme.ts` (new), `src/scenes/UIScene.ts`,
`src/obs/layout.ts`, `src/config.ts`, `index.html`, `src/main.ts`, and the new
`tests/obs/theme.test.ts`. They are interdependent; one owner.
