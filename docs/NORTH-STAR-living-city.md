# North Star — Growing the City & Making It Alive

> **Read this first.** One page to get our heads around the goal so we stop
> re-litigating it every session. Status as of **2026-06-18**, branch
> `feat/world-dressing`, HEAD `c62fcb0`.
>
> Two new inputs drive this doc:
> - **Town design research:** [`2026-06-18-option-c-civic-hub-hamlets.md`](./2026-06-18-option-c-civic-hub-hamlets.md) — the decided re-layout (140×100 civic-hub + hamlets).
> - **UI overhaul direction:** [`CleanShot 2026-06-18 at 14.56.21@2x.png`](./CleanShot%202026-06-18%20at%2014.56.21@2x.png) — a target-state mockup. **Not final — open for input.**

---

## 0. The goal, in one paragraph

Make Harvest of Madness read like **Stanford's Smallville**: a dense, organic
town where a believable population of agents *lives* — visiting real places,
talking, gossiping, planning gatherings, farming, feuding — and where the
player can **read what's happening** without drowning in text. The bar is
**density and legibility, not map size or new assets.** We already own every
asset we need. The recurring failure has been *placement and presentation*, not
capability.

**The standing target** (see memory `smallville-living-civ-goal`): full
Smallville-class behavior (conversations, gossip, party planning, scale) running
on the free LLM proxy, reached in phases.

---

## 1. Why we kept wasting time (read this so we don't repeat it)

Three rounds of the same complaint, because we kept fixing the wrong layer:

| Round | The complaint | The real cause | The lesson |
|------|----------------|----------------|------------|
| 1 | "Houses all identical, veg used as fences, agents conga-line, I can't read this madness" | In-world text soup + a decor hash that planted produce in vertical columns | Words don't belong in the world. Smallville shows **only emoji/initials** in-world; all sentences live in side panels. |
| 2 | "I liked the original cards, I just couldn't access them — it can scroll" | We replaced rich cards with compact chips | Don't trade richness for density — **make richness scrollable** instead. |
| 3 | "Still 25 agents, houses same size, no stores with aisles, everything's a grid. Did you even look at their code?!" | We'd studied the *renderer* but not the *map data* | the_ville is **140×100, ~1,360 interior-furniture tiles in large multi-room buildings** (~9× our density). The fix is **bigger, packed buildings and tight negative space**, not more grass. |

**The single most useful technical insight:** **furniture is render-only.**
Passability is tile-type-driven (`wall`/`floor`/`bedTile`/`shopTile`), so
furniture sprites never block pathfinding. Rooms can be packed arbitrarily dense
with **zero** pathfinding or test risk. This is the lever for "alive."

**The diagnosis (from Option C):** we lay a uniform road grid first, drop small
buildings into the cells, and cap decor at ~16 trees one-per-cell → big empty
lots with lonely trees, the "parking-lot" look. **Density-first placement** is
the cure.

---

## 2. What we've shipped (current build — 96×64)

All of this is **done, tested, and on `feat/world-dressing`**. Suite ~1073 green,
`tsc` clean.

**World & look**
- City expanded 64×40 → **96×64** (3× area).
- **10 two-room homes** (was 26 identical single rooms) — each with a divider
  wall + door gap, BFS bed-reachability preserved. ← _this is the current state;
  Option C revises it (§3)._
- **5 civic buildings** enlarged + densely furnished: supermarket with shelf
  **aisles**, tavern (bar + table grid + barrels), café (counter + tables),
  school (desk rows), office (desks). Plus a **park**.
- **Warm dirt roads** (replaced grey cobble) → organic farm-village feel.
- **Clustered decor** (trees/bushes/grass tufts) + authored **CC0 flowers**
  (fixed the "veg fence" — the old hash planted produce in columns).
- Tree canopies box-checked off building roofs (trees are 96×128 = 3×4 tiles).

**Legibility (the Smallville lesson)**
- **In-world text soup killed** — agents show **initials + emoji** only; all
  words moved to panels.
- **Scrollable agent roster** — kept the rich cards, windowed them into a
  horizontally scrollable strip (all agents reachable, not "4 + 22 more").
- **Conversation panel word-wraps** — full utterances reflow instead of clipping.

**Agent systems (already live)**
- **Diaries** — daily first-person journal entries in the feed.
- **Mortality** — deterministic death / suicide / murder (conservative
  thresholds; normal agents survive).
- **Roles** — emergent farmer/merchant/socialite/wanderer/banker from action
  histograms; role-based visiting of functional locations.
- **Governance v1** — propose + vote on a town rule (merged to `main`).
- **Party emergence** — agents converge on the tavern for gatherings.

**Honest gap:** homes are still cottage-scale and grid-placed, the residential
layout is still a grid, and at 96×64 there isn't room for big multi-room homes +
plots + reachability all at once. That's what Option C fixes.

---

## 3. The decided town direction — Option C (140×100 civic hub + hamlets)

Full plan: [`2026-06-18-option-c-civic-hub-hamlets.md`](./2026-06-18-option-c-civic-hub-hamlets.md).
This is the **agreed next structural move**. Summary:

- **Canvas → 140×100** (matches the_ville). Not for size's sake — for the room
  to make buildings big and negative space tight.
- **A dense central civic hub** on the spine (y=50): shop, tavern, café, school,
  office, + well/notice board, with a **park + pond** to the east.
- **Four named hamlets** (NW/NE/SW/SE), **3 personas each = 12** (adds `clem`
  and `moss` to today's 10; preserves north/south intent and all persona ids).
- **14 pre-zoned reserve lots** down the empty middle of both residential roads
  — visible "room to grow." Activation = add a persona + promote the lot into
  `HOMESTEADS`. No re-survey.
- **A countryside woodland ring** + center-trunk corridor reserved for *whole
  future hamlets*.
- **Density levers:** ~**500** decor items (rim woodland + ~80 clusters + avenue
  trees + bush/flower scatter, killing the 16-cap) and ~**1,300** interior
  furniture pieces (every home + civic building furnished).

**Two engine changes Option C requires (don't skip):**
1. **Reach budget 40 → 100.** A corner hamlet is ~95 A* tiles from a central
   tavern; 40 was tuned for 96×64 and is geometrically impossible at 140×100.
   This is a *reachability floor*, not an attendance threshold.
2. **Distance-weighted attendance** (the "more realistic" half): far hamlets
   attend big gatherings *occasionally*, not always — `attendProb ≈
   clamp(1 − pathTiles/DECAY, floor, 1)`, behind the mock/live split so mock
   stays deterministic. (Can ship step 1 alone if we want minimal scope first.)

**Invariants Option C must keep green** (same discipline as today): 12 homesteads
/ 12 beds, exact landmark counts, plots within Chebyshev-4 of doors,
road-first (every door's exterior is a path tile), **zero RNG / zero `Date`**
(re-running `generateMap()` is identical), 14 reserve lots valid.

---

## 4. UI overhaul — FINALIZED design (SpaceCon HUD)

> **UI source of truth is now [`docs/design_handoff_sim_hud/`](./design_handoff_sim_hud/)** —
> a **high-fidelity, final** handoff. The earlier rough mockup
> (`CleanShot 2026-06-18 at 14.56.21@2x.png`) is **superseded.** Files:
> `README.md` (full spec + design tokens), `Sim HUD Redesign.dc.html` (the HUD
> prototype), `Option C Blueprint.dc.html` (tile-exact map), `Town Layout
> Exploration.dc.html` (why Option C). The `.dc.html` files are **design
> references, not production code** — recreate the chrome in our own HUD layer
> using the SpaceCon tokens; keep the **real Phaser canvas** as the map.

The HUD becomes a **mission-control observability dashboard** (kills the "Game
Boy" debug readout). Structure:

- **Command bar (top):** wordmark · transport (play/pause/step) · speed
  (½/1/2/4×) · **Mock↔Live toggle** · clock · telemetry chips (in-flight,
  latency, tokens, **cost**).
- **KPI band:** Agents live · Conversations · Avg energy · Economy · Decisions.
- **Map viewport:** the real Phaser canvas + overlays — context chip, a
  **"Following {name}" chip**, speech bubbles, and a pulse ring on the selected agent.
- **Agent cards (bottom horizontal scroller):** swatch + name + **state badge**
  (Executing/Thinking/Idle), gold + energy bar, goal, action (color-by-verb),
  thought quote. **Click to inspect.**
- **Right rail, two states:**
  - **DEFAULT:** an **Active-conversation card** (host, know/invited/arrived,
    chat thread) + an **Event log**.
  - **INSPECTOR** (agent selected): **decision trace** (observation → thought →
    action → result) + **model/cost strip** (mock: `mock · 0 ms · 0 tok`; live:
    `fable-5 · latency · tokens`) + **memory stream** (OBS/REFLECT/PLAN chips).
- **Type — fixes the "terrible font" complaint directly:** Space Grotesk
  (display) / IBM Plex Sans (body) / IBM Plex Mono (labels). Icons: **Lucide**.
- **Palette:** SpaceCon cool-navy mission-control tokens (exact values in the README).

**Why it's a big step up:** it adds **click-into-agent inspection** (decision
trace + memory stream — the agents' cognition becomes legible) and makes the
**LLM dependency visible** (Mock/Live + live cost/latency/token telemetry +
kill-switch). Neither existed before. The Mock/Live split must read the sim's
**real** model-runner + cost accounting, not be a visual toggle.

**How it answers "gathering legibility":** the design already solves two of the
three pieces — **(a)** DS fonts fix readability, and **(b)** in-world bubbles are
**capped** (only the *selected* agent's thought + two ambient bubbles render, so
a crowd can't stack into soup). The **remaining** piece is purely a *world/sim*
concern: spread agent **bodies** across tiles/seats when they converge so the
sprites themselves don't pile on one tile (Phase B1).

**Conversation rail — resolved (both):** an **Active-conversation card** (the
focused gathering — host/know/invited/arrived + transcript) **plus** a
**multi-thread feed** of all active conversations, alongside the event log.

---

## 5. The plan & sequencing

Status: `[x]` done · `[~]` partial · `[ ]` planned.

**Phase A — World re-layout to Option C (140×100)** — _the agreed next build_
- [ ] A0. Bump dims (140×100), reach budget 40→100, retune camera. _(commit by itself; town clusters NW, still green)_
- [ ] A1. Road network (spine y=50, two residential roads, three trunks).
- [ ] A2. Civic hub `COMMONS` (5 buildings straddling the spine + well/board).
- [ ] A3. 12 homesteads (4 hamlets × 3), TDD-converge against map + party tests.
- [ ] A4. 14 reserve lots + new `reserve-lots.test.ts`; document future-hamlet ground.
- [ ] A5. Park + pond, ~500 decor (kill the 16-cap), ~1,300 interior pieces.
- [ ] A6. Reach budget 40→100 **floor only** (per decision). _Distance-weighted attendance deferred to a fast-follow — see Phase C._

**Phase B — UI overhaul (SpaceCon HUD)** — _design finalized in [`docs/design_handoff_sim_hud/`](./design_handoff_sim_hud/); builds on the 140×100 world_
- [ ] B1. **Gathering legibility (world side only):** spread agent **bodies**
      across tiles/seats when they converge so sprites don't pile on one tile.
      _(Font + bubble-cap are already solved by the design: DS fonts +
      selected-agent-only bubbles.)_
- [ ] B2. **Command bar** — wordmark, transport, speed, **Mock↔Live toggle**, clock, telemetry chips (in-flight/latency/tokens/cost).
- [ ] B3. **KPI band** (agents · conversations · energy · economy · decisions).
- [ ] B4. **Map viewport overlays** — context chip, follow chip, capped speech bubbles, selected-agent pulse ring.
- [ ] B5. **Agent cards** (swatch/state-badge/energy bar/action/thought), horizontal scroller, click-to-inspect.
- [ ] B6. **Right rail DEFAULT** — Active-conversation card (focused gathering) **+ multi-thread conversation feed** (all active chats) + Event log.
- [ ] B7. **Right rail INSPECTOR** — decision trace + memory stream + model/cost strip (reads the **real** model-runner + cost accounting, not a visual toggle).
- [ ] B8. **Wire SpaceCon tokens** (Space Grotesk / IBM Plex / Lucide) as the single source of color/type; record them in `CLAUDE.md` so future UI + artifacts match.

**Phase C — Deeper "alive" (toward full Smallville)** — _backlog_
- [ ] **Distance-weighted attendance** (deferred from A6): far hamlets attend big
      gatherings occasionally, not always — behind the mock/live split.
- [ ] Conversations & gossip at Smallville fidelity on the free LLM proxy.
- [ ] Per-hamlet visual identity (roof palette per hamlet).
- [ ] Terrain transition tiles (grass↔dirt↔path edges), second pond.
- [ ] Activate reserve lots into live hamlets as the population grows.
- [ ] Build controls (Minecraft-ish place/remove) — needs its own plan; grid is
      currently frozen/immutable.

**Sequencing note:** do **Phase A before Phase B** — the UI overhaul should be
built against the real 140×100 world (the finalized design already assumes it),
not the current 96×64 one.

---

## 6. Hard constraints (never violate)

- **Determinism:** no `Math.random`, no `Date` in map/sim generation. Tests
  re-run `generateMap()` and assert identity.
- **Tests stay green:** ~1073 today. Map structure/counts/connectivity,
  personas, party-emergence, observation, integration. TDD-converge coordinates;
  the tests are the source of truth, not the hand-authored coords.
- **Reachability:** every door → tavern must path through passable tiles within
  the reach budget (40 today → 100 under Option C). Plots ≤ Chebyshev-4 of doors.
- **Assets:** use only owned/credited assets (CC0/CC-BY-SA, attributed in
  CREDITS.md **and** CREDITS.txt — the asset-manifest test reads `.txt`). We do
  **not** redistribute Smallville's commercial tilesets.
- **Furniture is render-only** — exploit it for density; it can't break paths.
- **nvm shadows binaries:** use absolute node paths; run tests via
  `node_modules/vitest/vitest.mjs run`, tsc via `node_modules/typescript/bin/tsc --noEmit`.
- **Commits:** only when verified; `--no-gpg-sign`.

---

## 7. Decisions log (2026-06-18)

- ✅ **UI source of truth:** the finalized **SpaceCon HUD handoff**
  (`docs/design_handoff_sim_hud/`) supersedes the rough mockup screenshot.
- ✅ **In-world labels:** KEEP short name+sentence bubbles. Root cause of the old
  "madness" was a bad font + gathering pile-up, not sentences. The design fixes
  the font (Space Grotesk/IBM Plex) and **caps bubbles** (selected agent + 2
  ambient); only **B1 body-spreading** remains.
- ✅ **Agent roster:** bottom horizontal scroll strip (as design).
- ✅ **Reach change scope:** floor-only (40→100) now; distance-weighted
  attendance deferred to a fast-follow (Phase C).
- ✅ **Build order:** world re-layout (Phase A) before UI overhaul (Phase B).
- ✅ **Conversation panel — BOTH:** an Active-conversation card (focused
  gathering) **and** a multi-thread feed of all conversations, with the event log.
- ⏸ **Design tokens:** keep SpaceCon tokens in the handoff README for now;
  recording them in `CLAUDE.md` is **deferred** (user: not yet).

_Still genuinely open (decide during the build, not blocking):_ the B1
body-spreading technique, and whether "MADOW VALLEY" is the final town name.

---

## Appendix — key files & references

- **Town data:** `src/world/map.ts` (`ROAD_SEGMENTS`, `COMMONS`, `HOMESTEADS`,
  `RESERVE_LOTS`, `PARK`/`POND`, decor scatter). Dims in `contracts/types.ts`.
- **Render:** `src/world/render.ts` (decor/furniture sprite mapping),
  `src/scenes/WorldScene.ts` (consumes map + decor, in-world labels).
- **HUD:** `src/scenes/UIScene.ts` (~1200 lines, pure Phaser, no DOM) + layout
  math in `src/obs/layout.ts`. Camera/fonts in `src/config.ts`.
- **UI design (FINAL):** `docs/design_handoff_sim_hud/` — `README.md` (spec +
  SpaceCon tokens), `Sim HUD Redesign.dc.html`, `Option C Blueprint.dc.html`,
  `Town Layout Exploration.dc.html`.
- **Agents:** `src/agents/personas.ts` (10 today → 12 under Option C),
  `Observation.ts`, `RolesSystem`, `DiarySystem`, `Mortality.ts`, governance.
- **Reference world:** `/Users/johns/Projects/generative_agents` (the_ville_jan7.json
  = 140×100, ~1,360 furniture tiles; `main_script.html` = the panel-driven UI).
- **Research:** `docs/deep-research-v1.md`, `docs/deep-research-v2.md`,
  `docs/kickoff-fable5.md`, `docs/superpowers/OVERNIGHT-BUILD-LOG.md`.
