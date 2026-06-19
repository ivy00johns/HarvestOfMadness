# Contract — Phase C · Slice C6: Activate reserve lots into a live central hamlet

**Branch:** `feat/phase-c-reserve-activation`
**Goal:** Promote three pre-zoned reserve lots near the civic hub into **live
homesteads** with three new townsfolk — the town's first growth *inward*, toward
the commons. This **pays off the distance-weighted attendance slice** (`cbde99e`):
today all 12 homes sit 89–99 A* tiles from the central tavern, so the near/far
attendance gradient is real-in-formula but barely bites. The activated lots are
~44–58 A* tiles from the tavern, so the gradient finally **differentiates** —
near folk attend seeded gatherings reliably, far corners attend occasionally.

## Why this shape (from the map/test survey)

`HOMESTEADS` is the **single source**: `stampHomestead` stamps room+divider+bed+
plot and pushes the `bed`+`house` landmarks; `HOMESTEAD_DOORS`, `BUILDINGS`
(renderer), and `PERSONAS` (start tiles) all **derive** from it. The reserve lots
were authored as **drop-in homesteads** (`reserve-lots.test.ts` already proves:
footprint+plot entirely grass, door-exterior-on-road-path, plot ≤ OBSERVATION_RADIUS
of door, non-overlapping). So activation = **convert lot rect → `HomesteadSpec`,
append to `HOMESTEADS`, remove from `RESERVE_LOTS`, add a persona.** Render,
pathfinding, and most tests flow automatically and *gain* coverage of the new
homes for free.

## The three lots to activate (a new central hamlet — "Greenhollow")

North road (y=20) terrace, between the center (x=70) and east (x=116) trunks. All
door-side `S` (exterior on the y=20 road). Footprints are **5×5** (lot rects),
so the town now spans **three** house sizes (5×5 / 8×8 / 9×8) — reinforces the
"organic, hand-built" invariant.

| Lot | house rect → spec (top-left, size) | bed | door (S) | plot | ~A*→tavern |
|---|---|---|---|---|---|
| `lot_n4` | {76,15} 5×5 | {78,17} | {78,19} | {81–83,16–19} | ~44 |
| `lot_n5` | {84,15} 5×5 | {86,17} | {86,19} | {89–91,16–19} | ~50 |
| `lot_n6` | {92,15} 5×5 | {94,17} | {94,19} | {97–99,16–19} | ~58 |

(Divider check for 5×5: `stampHomestead` fires the divider at `w>=5 && h>=4` →
dcol = x0+3, gapRow = y0+2; the bed sits on the door side of the divider → the
door→bed BFS stays green. Already verified by construction; the suite is the
arbiter.)

## The three new personas — "Newcomers to the commons", VARIED roles

Append to `PERSONAS` (AFTER the existing 12 — never prepend; `HOMESTEADS[0]`/`BED_POS`/
`FIELD_RECT` must stay = brix). Each ~50 words, trait+name alliterative, packs
traits/speaking-style/backstory/starting-goal, `start: { ...HOMESTEAD_DOORS.<id> }`.

**LOAD-BEARING constraint — protect the party-emergence unseeded negative
control** (`party-emergence.test.ts:251`: "without seeding, < 3 agents near the
tavern"). These three live ~44–58 tiles from the tavern; if all three read as
tavern-social they can tip the unseeded baseline to ≥3 and break that control.
**Lean their roles toward farmer / merchant / home-and-work — NOT tavern-social.**
The attendance payoff is about *seeded* gatherings (their nearness makes them
attend when a party fires); it does NOT require them to casually loiter at the
tavern. Keep the mock keyword flavor off "social"/tavern; the implement agent
TDD-verifies the unseeded control stays green.

| id | name | lot | role-lean | color (unused hex) |
|---|---|---|---|---|
| `juno` | Hopeful Juno | lot_n4 | **farmer** — young newcomer, fresh start, tends a starter plot diligently; home/plot-oriented | `0xfdd835` (bright yellow) |
| `pim` | Peddler Pim | lot_n5 | **merchant** — ex-traveling trader settled by the market to keep selling; shop-oriented | `0xff7043` (deep orange) |
| `odo` | Handy Odo | lot_n6 | **tinker/builder** — jack-of-all-trades who came to help raise the new homes; work/home-oriented | `0x5c6bc0` (indigo) |

## Files & changes

### 1. `src/world/map.ts`
- **Append 3 `HomesteadSpec` entries** to `HOMESTEADS` (converted from lot_n4/n5/n6
  rects per the table; `house` = top-left, `size` = {w:5,h:5}). Add a short
  comment marking the new "central Greenhollow hamlet (activated reserve lots)".
- **Remove `lot_n4`, `lot_n5`, `lot_n6`** from `RESERVE_LOTS` (they're stamped now;
  leaving them makes `reserve-lots.test.ts` "footprint entirely grass" fail). Add
  a one-line comment noting they were activated in C6. `RESERVE_LOTS` 14 → **11**.
- Nothing else in map.ts changes — `BUILDINGS`, `HOMESTEAD_DOORS`, `stampHomestead`,
  `generateMap` all consume `HOMESTEADS` and pick up the 3 new homes automatically.

### 2. `src/agents/personas.ts`
- **Append 3 personas** (juno/pim/odo) per the table, bound to `HOMESTEAD_DOORS.<id>`.
  Keep the file-header note about mock keywords; choose descriptions whose flavor
  yields the intended non-tavern roles.

### 3. Tests — surgical count bumps (the ONLY frozen assertions that move)
- `tests/world/map.test.ts`: `HOMESTEADS` length `12 → 15` (L44); `beds` `12 → 15`
  (L162); `count("bed") 12 → 15` (L166); `count("house") 12 → 15` (L167).
- `tests/agents/observation.test.ts`: `bed` landmark count `12 → 15` (L194);
  `house` landmark count `12 → 15` (L195).
- `tests/world/reserve-lots.test.ts`: `>= 14 → >= 11` (L12).
- `tests/agents/party-emergence.test.ts`: stale "of 12" comment → "of 15"
  (cosmetic, L194 description string); **no assertion change** — the `>= 4` knower
  / `>= 3` convergence / `< 3` unseeded controls must all stay green as-is.

### 4. NEW test — `tests/world/reserve-activation.test.ts`
Pins the activation invariants so a future regression can't silently un-wire them:
- The 3 Greenhollow ids (`juno`/`pim`/`odo`) are present in **both** `HOMESTEADS`
  and `PERSONAS`, and each persona's `start` equals its homestead door.
- Each activated home: door-exterior is a `path` tile, interior has exactly 1
  bedTile reachable from the door (BFS), plot is all `soil`, footprint stamped
  (NOT grass) — i.e. it really is a live homestead now.
- **The payoff assertion:** each activated door's A* path length to the tavern is
  **strictly less than** the *minimum* corner-homestead door→tavern A* length —
  proving the activated hamlet is genuinely "nearer" and the attendance gradient
  now differentiates. (Use the same A* the party-emergence reachability test uses.)
- The activated lot ids are **absent** from `RESERVE_LOTS`.

## Determinism & invariants — MUST hold (tests are the source of truth)
- **Zero `Math.random` / zero `Date`** — all hand-authored coords + persona prose.
  Re-running `generateMap()` stays byte-identical.
- **Full suite green** (`node_modules/vitest/vitest.mjs run`) — currently 1249 on
  main. Specifically preserve:
  - `party-emergence.test.ts`: the **unseeded `< 3` near-tavern negative control**
    (the headline risk), plus `>= 4` diffusion knowers and `>= 3` convergence.
  - `map.test.ts`: per-homestead door-exterior-path, interior-1-bed-reachable,
    plot-all-soil, tavern-reachability now auto-cover the 3 new homes — they must
    pass (5×5 + divider + bed-on-door-side is valid by construction).
  - `reserve-lots.test.ts`: the remaining 11 lots stay valid drop-ins.
  - `personas.test.ts`: start-position uniqueness holds across 15 personas.
  - `attendance-wiring.test.ts` / attendance unit tests: untouched logic; the
    near/far split now has real near homes (may strengthen, must not regress).
  - `mock-determinism.test.ts`: uses inline personas — must stay byte-identical.
- **Reachability floor:** every door (now 15) → tavern ≤ 100 A* (new homes ~44–58).
- `node_modules/typescript/bin/tsc --noEmit` clean.

## Out of scope (explicit)
- Retuning `ATTEND_DECAY` / attendance constants — the gradient bites with the
  shipped formula; constant changes touch frozen attendance invariants. Later.
- Per-hamlet roof palette (C4), terrain transitions (C5), sentiment-affinity (C1).
- Activating MORE than these 3 lots (the remaining 11 stay reserved capacity).
- Replenishing `RESERVE_LOTS` back to 14 — activation *consumes* capacity by
  design ("room to grow" shrinks as the town grows); 11 remaining is honest.
- North Star doc update + commit — orchestrator does these after the gate.
