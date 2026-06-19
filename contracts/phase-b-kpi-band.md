# Contract — Phase B-3: SpaceCon KPI band

Single source of truth for the implement agent AND the verify critics. Adds the
**five-tile KPI band** (design_handoff README §2) in the left column, directly below
the command bar and above the map. Structural: inserts a new region in `layout.ts`
(map top shifts down) + updates `layout.test`. Builds on B-0 tokens + B-2 command bar.

Run tools with nvm-absolute node: tests `node_modules/vitest/vitest.mjs run <f>` · full `node_modules/vitest/vitest.mjs run` · tsc `node_modules/typescript/bin/tsc --noEmit`.

## Design target (README §2 — pure Phaser, theme.ts tokens)

A horizontal row of FIVE equal tiles, `gap ~12px`, in the LEFT column (spanning the
map's width — i.e. x∈[0, rightX), left of the right panel), directly below the
command bar.
- **Tile:** `card` bg (#111c30), `borderCard` border (#1f2c46), radius ~12, padding ~12×15. A mono uppercase label (~10.5px, `ink400`) over a display-700 value (~24px).
- **The five tiles (label · value · value color):**
  1. `AGENTS LIVE` · count of living agents · white
  2. `CONVERSATIONS` · active conversation count · `cyan300`
  3. `AVG ENERGY` · mean energy as `NN%` · `positive500`
  4. `ECONOMY` · total gold as `N,NNNg` (the `g` faint/`ink400`) · white
  5. `DECISIONS` · total decisions · white

All values come from REAL sim data (see Data sources). No fabricated numbers.

## Layout change (`src/obs/layout.ts`)

- Add `KPI_BAND_H` (~58-64px; integer) and a KPI band region: it spans the LEFT
  column width (`x: 0 .. rightX`, i.e. `kpiW = rightX` or the map width), `y: topH`,
  height `KPI_BAND_H`. Expose the band rect + a per-tile rect helper (5 equal tiles
  with the gap) so UIScene and tests can address tiles.
- **The map shifts down:** `mapY = topH + KPI_BAND_H`; `mapH` reduces by `KPI_BAND_H`.
  The right panel (`rightTop`) and bottom strip are UNCHANGED (the band is left-column only; the rail still starts at `topH`). Verify the map still has a sane min height after the shift on the design viewport.
- Keep all numbers integer; `FONT_SIZE_*` ≥12 (rule 14). The 24px value font is a new larger size — fine (it's ≥12).
- A `kpiTileRect(i)` (0..4) helper + a band rect; mirror the existing region/rect helper style.

## Data sources (real — derive in UIScene from existing feeds)

- AGENTS LIVE: `conn.controls.agents().filter(a => a.alive !== false).length` (use the real alive flag).
- CONVERSATIONS: the count of currently-active conversations from the existing conversation/party source the transcript already reads (if none tracked as a live count, derive from the active-conversation/party state the HUD already has; 0 when none). Use the SAME source the transcript/party panels use — do not invent.
- AVG ENERGY: mean of `agents().map(a => a.energy)` rounded to `NN%`.
- ECONOMY: sum of `agents().map(a => a.gold)`, formatted with thousands separators + `g`.
- DECISIONS: sum of `agents().map(a => a.decisionsTotal)` (or the real total-decisions field).

If a source genuinely doesn't exist, show `0`/`—` honestly and note it — never a fake number.

## Tests

- **`tests/obs/layout.test.ts`** — add a KPI-band describe block: band region exists with `KPI_BAND_H` (integer, in band), spans the left column, sits at `y===topH`, the map now starts at `topH + KPI_BAND_H` (update the existing "map fills center-left" / "map top docks at topH" assertions to the new `mapY` — this is a real structural change, assert the new value with equal strictness, do not loosen), 5 equal tiles tile-rects are within the band and non-overlapping. Keep rule-14 + integer + hit-testing intact.
- If a KPI value-formatting helper is extracted (e.g. `formatEconomy`), add a small unit test for it (thousands separators, the `g` suffix, % rounding).
- Any other test that pinned the old `mapY===topH`: update to `topH + KPI_BAND_H`.

## Hard gates (verify must check ALL)

- Full suite green + `tsc --noEmit` clean.
- Map region correctly shifted (`mapY === topH + KPI_BAND_H`); right panel + strip unchanged; no region overlap/gap; map still has a usable size.
- KPI values read REAL data (agents/energy/gold/decisions/conversations) — no fabricated numbers; honest `0`/`—` when a source is empty.
- Tokens single-source (no new SpaceCon hex outside theme.ts); world rendering + determinism untouched.
- No gamed gate: layout.test changes reflect the new structure with equal-or-greater strictness; no unrelated assertion weakened.

## File ownership
A SINGLE implement agent owns: `src/scenes/UIScene.ts`, `src/obs/layout.ts`,
`tests/obs/layout.test.ts` (+ a new tiny helper test if a formatter is extracted).
Do NOT change `src/obs/theme.ts` values, `src/world/`, or `config.ts` world colors.
