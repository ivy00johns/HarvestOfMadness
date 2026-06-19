# Contract — Phase B-5: SpaceCon agent cards

Single source of truth for the implement agent AND verify critics. Restyles the
bottom agent-card scroller into the SpaceCon card (design_handoff README §4). Builds
on B-0 tokens. The card DATA model (AgentCardModel / buildAgentCard) is UNCHANGED —
this is a draw/restyle of `createCard`/`updateCard` + card layout constants + a few
pure helpers. Click-to-select still opens the trace panel (the full inspector rail is B-7).

Run tools nvm-absolute: tests `node_modules/vitest/vitest.mjs run <f>` · full `node_modules/vitest/vitest.mjs run` · tsc `node_modules/typescript/bin/tsc --noEmit`.

## Design target (README §4 — pure Phaser, theme.ts tokens)

**Card** — fixed width ~248px, radius ~12, padding ~13×14, pointer cursor.
- IDLE: `card` bg (#111c30), `borderCard` border (#1f2c46).
- SELECTED (this card's agent is the selected one): `cardSelected` bg (#15233c), `brand500` border (a 1px brand ring is enough in Phaser).

**Contents (top → bottom):**
1. **Header row:** color swatch (~11px square, the agent's color, radius ~3) + name (display 600, ~14.5px, white, ellipsis/clip) + **state badge** (right-aligned).
2. **Stats row:** gold (mono ~12px, `p2`) + an energy bar (track ~6px, `divider` #1c2840; fill colored by level; radius 4) + `E{n}` (mono ~10.5px, `ink400`).
3. **Goal:** body font ~12px, `ink300`, min-height ~32px (wrap/clip as today).
4. **Action row:** mono ~11px, color BY VERB (see helper) + a green `✓` (`positive500`).
5. **Thought quote:** body font ~12px italic, `ink400`, a top divider (1px `divider`) + small top padding, wrapped in curly quotes “…”.

(The current card also shows plan/needs/relationships/meta. Fold those out of the
primary card face per the design — the deep per-agent detail moves to the INSPECTOR
rail in B-7. Keep the data available; just don't clutter the card. If dropping a
field would lose info with no inspector yet, you may keep ONE compact meta line, but
prefer the clean design.)

## Pure helpers (extract + unit-test in a small module, e.g. `src/obs/cardStyle.ts`)

- `stateBadge(fsm)` → `{ label, color, tint }`: EXECUTING → label "EXECUTING", `positive500` on exec tint; THINKING → `p2` on think tint; IDLE → `ink400` on idle tint. (Use theme tints.)
- `actionVerbColor(action)` → number: `TALK_*` (startsWith "TALK") → `cyan300`; `WAIT` → `ink400`; everything else → `brand400`.
- `energyLevelColor(ratio)` → number: `> 0.55` → `positive500`; `> 0.25` → `p2`; else → `p1`. **This aligns the energy threshold to design §4 (>55%) — the deferred B-0 item.** Apply this same helper to the command-bar/KPI energy coloring if they duplicate the rule, so there is ONE energy-color source.
- Unit-test all three (`tests/obs/cardStyle.test.ts`): boundary cases (0.55, 0.25, exact), TALK_TO/TALK_ABOUT → cyan, WAIT → ink, MOVE_TO/HARVEST/etc → brand, each fsm → right color+tint.

## Layout (`src/obs/layout.ts`)

- If card width changes to 248, update `CARD_W` (and any test). Update `cardHeight` if the new content stack needs a different height; keep `cardRect`/`cardsPerPage`/`cardIndexAt` correct (hit-testing must still resolve the card under a point). Keep integers + rule-14 (≥12px).
- The bottom-strip region (`stripY`/`stripH`) can stay; only the card's internal layout + width change. If `stripH` needs a small adjust for the new card height, do it and update the strip/card tests with the new exact values (not loosened).

## Selection visual

- When `this.selectedAgent === card name`, draw the SELECTED style (cardSelected bg + brand500 border). Clicking still calls `toggleTracePanel` (unchanged) — the card highlight is purely additive. `cardSelected` is already exported from theme.ts (B-0).

## Tests

- New `tests/obs/cardStyle.test.ts` (the 3 helpers).
- Update `tests/obs/layout.test.ts` ONLY if a card constant (CARD_W / cardHeight / stripH) changed — to the new exact value, equal-or-greater strictness, never loosened. Keep cardIndexAt/cardsPerPage/cardRect hit-testing assertions valid.
- Do NOT change `inspector.test.ts` / the AgentCardModel data projection — the data is unchanged.

## Hard gates (verify must check ALL)

- Full suite green + `tsc --noEmit` clean.
- Card hit-testing still correct (cardIndexAt resolves the right card; cardsPerPage sane).
- ONE energy-color source (the helper); threshold now >55%/>25% per design (the B-0 deferral resolved).
- Selected card shows the selected style AND clicking still opens the trace panel (selection behavior preserved).
- Tokens single-source (no new SpaceCon hex outside theme.ts); world rendering + determinism untouched; AgentCardModel data projection unchanged.
- No gamed gate: any layout.test change reflects a real constant change with equal-or-greater strictness; no unrelated assertion weakened.

## File ownership
A SINGLE implement agent owns: `src/scenes/UIScene.ts`, `src/obs/layout.ts`,
`src/obs/cardStyle.ts` (new), `tests/obs/cardStyle.test.ts` (new), and
`tests/obs/layout.test.ts` (only if a card constant changed). Do NOT change
`src/obs/theme.ts` values, the AgentCardModel/inspector projection, `src/world/`, or `config.ts` world colors.
