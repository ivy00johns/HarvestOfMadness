# Contract — Phase B-7: SpaceCon right rail (INSPECTOR state)

Single source of truth for the implement agent AND verify critics. Rebuilds the
INSPECTOR rail (agent selected) into the SpaceCon design (README §6): header +
stat strip + decision-trace timeline + model/cost strip + memory stream. Adds ONE
new data seam (the memory stream). Builds on B-0 tokens + B-6 default rail.

Run tools nvm-absolute: tests `node_modules/vitest/vitest.mjs run <f>` · full `node_modules/vitest/vitest.mjs run` · tsc `node_modules/typescript/bin/tsc --noEmit`.

## Data reality (from recon)

- `DecisionTraceEntry` (contracts/types.ts) has: turnId, day, phase, observationJson, rawResponse, parsedOk, action, model, latencyMs, tokensIn?, tokensOut?. It does NOT have a per-entry "thought" or "result" field.
  - **Observation** node ← `observationJson`.
  - **Thought** node ← the Inspector helper that derives thought (`Agent.lastThought` or parsed from `rawResponse`) — for the NEWEST entry; older entries may have no stored thought → render honestly ("—"/parsed-if-available).
  - **Action** node ← `action`.
  - **Result** node ← PARTIAL: for the newest entry use `AgentCardModel.lastAction.ok`/`reason`; older entries have no per-entry result → show the entry's `parsedOk` status honestly, NOT a fabricated outcome.
- model/latencyMs/tokensIn/tokensOut are on the trace entry + AgentCardModel. **Cost is NOT tracked** → the model strip shows model·latency·tokens (mock: `mock · 0 ms · 0 tok`; live: `{model} · {latency} ms · {in}/{out} tok`); do NOT fabricate a dollar cost.
- **Memory stream is NOT exposed to the HUD** — it lives in the cognition memory store. ADD a seam (below). `MemoryEntry` (contracts/types.ts) has: type (`"observation"|"reflection"|"plan"`), text, importance (1-10), createdAt, ...

## New data seam (additive)

- Add an OPTIONAL method to the SimControls interface (wherever it's declared — find it; same place as `cognitionMetrics?`/`attendanceSnapshot?`): `memoryStream?(agentName: string): MemoryEntry[]`.
- Implement it in `src/obs/wiring.ts` (the Object.assign controls): return `manager.cognition()?.<memoryStore>.all(agentName) ?? []` (use the real store accessor — find the exact method; the recon noted `MemoryStore.all(agentName)`). Newest-first or as stored; the HUD will cap/slice.
- Do NOT modify the MemoryStore/cognition internals — only expose the existing data. Additive optional method → existing callers/tests unaffected.
- Add a focused test that the seam returns the agent's real memory entries (or an empty array when none / when cognition absent) — `tests/obs/*` or `tests/agents/*` as fits.

## Design target (README §6 — pure Phaser, theme.ts tokens; replaces the current trace panel)

One tall card in the rail (same surface; `borderInspector` #2f4a6b border):
- **Header:** color swatch (~13px) + name (display 700 ~18px) + persona sub (~12px `ink400`) + state badge + close ✕ (a ~26×26 control-bg button, `borderControl`).
- **Stat strip:** three inset mini tiles (`insetTile` bg, `borderCard`) — Gold (`p2`), Energy (level-colored via `energyLevelColor`), Decisions (white).
- **Decision trace** (vertical timeline, colored nodes + connector `borderCard`):
  1. Observation — node `ink500`, mono label, `ink300` text (what the agent saw — from observationJson; summarize/clip, don't dump 500 chars).
  2. Thought — node `cyan500`, label `cyan300`, italic `ink200`.
  3. Action — node `brand500`, label `brand400`, mono white (e.g. `MOVE_TO (66,49)`).
  4. Result — node `positive500`, label `positive500`, `ink300` (honest status per above).
- **Model/cost strip:** an inset pill row — model name (mono ~10.5px; `cyan300` when live, `ink400` when mock) · latency · tokens. Mock `mock · 0 ms · 0 tok`; live `{model} · {latency} ms · {in}/{out} tok`. (No dollar cost — not tracked.)
- **Memory stream:** mono header, then rows of a **tag chip** + memory text (`ink300`) + importance (mono ~10px `ink500`). Tag chip (mono ~8.5px 600, radius 4, padding 3×5, min-width ~48, centered): `OBS` (`ink300` on obsTag fill `#1f2c46`), `REFLECT` (`cyan300` on reflect tint), `PLAN` (`brand400` on plan tint). Source rows from the new `memoryStream` seam (cap a sensible N, newest/important first); honest empty state when none.
- Scroll: keep the existing wheel-scroll for overflow if the content exceeds the panel.

**Clean up:** replace the pre-existing hardcoded hexes in the old trace panel (`0x191d24` bg, `#cdd3dd` text) with theme tokens (the B-6 critics flagged these for B-7). After this slice there should be NO hardcoded SpaceCon-ish hex in the inspector.

## Behavior (preserve)

- Selecting an agent (card click or event-log turn-row click) → INSPECTOR replaces the DEFAULT card (in place; `panelRect === activeConvRect`). Close ✕ or re-click the same card → back to DEFAULT. (This wiring exists — keep it; you're replacing the panel CONTENTS/style.)
- The trace data still comes from `buildAgentCard(agent).trace`; the AgentCardModel projection is UNCHANGED.

## Tests

- New seam test (memoryStream returns real entries / honest empty).
- If a pure helper is extracted (e.g. `memoryTagChip(type)` → {label, color, tint}; `traceNode(kind)` → color), unit-test it.
- Keep `inspector.test.ts` (formatTraceEntry/Summary, buildAgentCard) GREEN; if those format helpers are no longer used by the new render, you may keep them (still exported/tested) — do NOT delete tested helpers just to tidy; if you retire one, remove its test in the same honest move and note it.
- Update `tests/obs/layout.test.ts` only if a panel layout field changed (the panel already maps to activeConvRect; likely no change). Equal-or-greater strictness.

## Hard gates (verify must check ALL)

- Full suite green + `tsc --noEmit` clean.
- The memory seam exposes REAL memory entries (no fabrication); honest empty state.
- The 4 trace nodes + model strip read REAL trace data; the Result node and cost are honest about what's NOT tracked (no invented outcome/dollar figure).
- Selection swap DEFAULT↔INSPECTOR still works; close returns to DEFAULT.
- Tokens single-source: NO hardcoded SpaceCon hex in the inspector (the old 0x191d24/#cdd3dd are replaced with tokens); any new color is a theme.ts token.
- AgentCardModel projection unchanged; cognition/MemoryStore internals unchanged (only the additive wiring seam); world rendering + determinism untouched.
- No gamed gate: no unrelated assertion weakened; any retired helper's test removed honestly (not silently).

## File ownership
A SINGLE implement agent owns: `src/scenes/UIScene.ts`, `src/obs/wiring.ts`, the
SimControls interface declaration (find it — `contracts/types.ts` or `src/obs/*`),
a new seam test, and (only if changed) `tests/obs/layout.test.ts` + a helper test.
Do NOT change the MemoryStore/cognition internals, the AgentCardModel projection
(Inspector buildAgentCard), `src/obs/theme.ts` values (you may ADD a token only if a
genuinely new color is needed — pin it), `src/world/`, or `config.ts`.
