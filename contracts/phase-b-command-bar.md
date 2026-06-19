# Contract — Phase B-2: SpaceCon command bar

Single source of truth for the implement agent AND the verify critics. Replaces the
current two-row top chrome (`buildTopBar` + `buildBadgeRow`) with the **single
SpaceCon command bar** (design_handoff README §1). First structural slice — it
changes the `layout.ts` top region + `layout.test`. Builds on B-0 tokens (`src/obs/theme.ts`).

Run tools with nvm-absolute node: tests `node_modules/vitest/vitest.mjs run <f>` · full `node_modules/vitest/vitest.mjs run` · tsc `node_modules/typescript/bin/tsc --noEmit`.

## Design target (README §1 — recreate in pure Phaser, using theme.ts tokens)

A single full-width bar, left group → flexible spacer → right group. Background a
navy fill (cmd gradient `#10192b`→`#0d1424`; a flat `cmdGradTop` fill is acceptable
in Phaser if a gradient is impractical — note which), bottom border `borderControl`.

**Left group (→):**
- **Wordmark:** a small dot (cyan500, subtle glow if cheap) + `MADOW VALLEY` in display font 700, ~15px, white.
- **Transport segment:** a rounded container (`control` bg, `borderControl`, radius ~8-10). Play/Pause toggle button — ACTIVE (paused) fills `brand600` white; idle transparent `ink300`. Plus a step button (⏭). Wire to the EXISTING controls: `conn.controls.pause()/resume()/isPaused()` and `conn.controls.step()`.
- **Speed segment:** same container; the existing `SPEEDS` buttons (½ / 1× / 2× / 4×). Selected fills `brand600` white bold; rest transparent `ink300`; mono ~12px. Wire to `conn.controls.setSpeed(s)` and reflect the current speed.
- **Mock/Live segment:** same container; two buttons MOCK / LIVE, mono uppercase ~11px, selected fills `brand600` white. It must reflect the REAL runner mode from `this.killSwitch.state()` ("mock" | "live" | "offline") — NOT a cosmetic flip. Mock is terminal (env-gated) so render it as the locked/selected state when mock; when live/offline, reflect that state (and the existing kill-switch behavior). Do not fabricate a mock→live switch.

**Right group (→):**
- **Clock:** mono uppercase label (`ink400`) + display 600 white day/phase + the phase glyph in `p2` (e.g. `DAY 2  ☀ MORNING`). Reuse the existing `PHASE_ICON` + time source feeding the old `statusText`.
- **Telemetry chips** (mono ~11px, `borderControl`, radius 6, padding 3×8) — show REAL data only, never fabricated:
  - in-flight: `⟳` cyan + count of agents currently THINKING (derive from `conn.controls.agents()` fsm === "THINKING").
  - the cognition tally that the old `cogMeter` showed (from `conn.controls.cognitionMetrics?.()`), as a chip (latency/tokens or the plan/reflect counts — keep whatever real metric exists).
  - cost: `$0.00` in mock (`positive500`) per README; in live, real cost is NOT tracked yet → show `$—` (or omit) — do NOT show a fake dollar figure. Real cost accounting is the dedicated cross-cut slice.

**Preserve existing behavior (fold into the bar, don't lose):**
- PAUSED state: reflected by the transport toggle's active fill (the standalone `pausedBadge` can be dropped or kept as a subtle bar indicator).
- BUDGET REACHED: keep an indicator (a chip or small badge in the bar) driven by the existing `budgetReached` latch.
- Kill-switch state (`llm_offline`/`llm_recovered` bus events still call `this.killSwitch.apply` → re-render the Mock/Live segment).

## Layout change (`src/obs/layout.ts`)

- Collapse the two-row top into ONE command bar: add `CMDBAR_H` (~44-48px). Set `topH = CMDBAR_H`. Keep the `HudLayout` fields that other code/tests read, but make the top a single bar: `topbarH = CMDBAR_H`; the badge row collapses (`badgeRowH = 0`, `badgeRowY = CMDBAR_H`) OR remove the badge-row fields and update every reader. Whichever you choose, `topH` stays the single source other regions key off (map starts at `topH`, `isPointOverHud` uses `topH`). The map/right-panel/strip regions must still compute correctly from the new `topH`.
- Segment positions within the bar can be computed in UIScene at draw time (left group from a left pad, right group from the right edge), OR add layout fields — your call, but keep it test-covered.
- `FONT_SIZE_*` stay ≥12 (rule 14); all layout numbers stay integers.

## Tests

- **`tests/obs/layout.test.ts`** — UPDATE the top-region assertions to the single command bar (this is a real structural change, NOT a weakening): assert `topH === CMDBAR_H`, the bar spans full width, the map/right-panel/strip dock correctly below/around it, `isPointOverHud` still treats the bar as HUD. Keep rule-14 (≥12px) + integer-pixel + hit-testing assertions. Any assertion you change must reflect the new structure with equal-or-greater strictness.
- Add focused assertions for the command bar height + that the map top is `topH`.
- Any UIScene-behavior test (controls/clock) that referenced the old two-row layout: update to the new bar.

## Hard gates (verify must check ALL)

- Full suite green + `tsc --noEmit` clean.
- Controls still work: pause/resume, step, speed select all call the real `conn.controls.*` and reflect state; the clock shows the real day/phase.
- Mock/Live reflects REAL `killSwitch.state()` (not cosmetic); kill-switch bus events still re-render it.
- No fabricated telemetry: every chip shows a real value or an honest placeholder (`$—`) — cost is `$0.00` only in mock.
- `topH` is the single top-region anchor; map/right-panel/strip still compute correctly; `isPointOverHud` correct.
- World rendering + determinism untouched; tokens still single-source in theme.ts (no new hardcoded SpaceCon hex).
- No gamed gate: layout.test changes reflect real new structure, not loosened assertions; no unrelated test weakened.

## File ownership
A SINGLE implement agent owns: `src/scenes/UIScene.ts`, `src/obs/layout.ts`, and
`tests/obs/layout.test.ts` (+ any UIScene-behavior test that pinned the old top bar).
Do NOT touch `src/obs/theme.ts` values, `src/world/`, or `src/config.ts` world colors.
