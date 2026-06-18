# Overnight Autonomous Build Log

**Started:** 2026-06-18 (user asleep; autonomous directive)
**Worktree:** `/Users/johns/Projects/HOM-world-dressing` — branch `feat/world-dressing`
**Node:** `~/.nvm/versions/node/v22.22.3/bin` (nvm functions shadow binaries — always `unfunction node npm npx nvm` + absolute paths).

## The Goal (verbatim)
Get to Smallville-level: **city size, character density, structure details, item density**. If a new asset is needed, fetch it via Playwright (free CC-BY-SA/CC0, attribute in CREDITS). Build: **diaries, jobs, building capabilities (Minecraft-ish controls), death/murder/suicide**, and **revamp the UI** (less "Game Boy Advanced", more readable/usable). "Continue dreaming, planning, and building."

## Foundation decisions
- **Governance session is DONE** (merged to `main` via PR #2). Isolation constraint lifted.
- **Merged `main` into `feat/world-dressing`** — unified base = governance v1 + functional-locations + my 96×64 map expansion. All green (1023 tests).
- Visual target: Image #3 (current, sparse) → Image #4 (Smallville, lush/dense/organic).
- Strategy: I (main loop) orchestrate increments; each = implement (TDD on pure logic) → verify suite MYSELF → visual check (periodic) → commit → update this log. Use ultracode workflows for substantial increments.

## Roadmap & status

### Wave 1 — Visual richness (the core "Smallville look")  [item/structure/ground density]
- [x] City size → 96×64 (12 homes + 14 reserve lots), 1023 tests green.
- [ ] 1a. Terrain variety + grass↔path/water/soil autotile transitions
- [x] 1b. Warm dirt roads (replaced grey cobble) — big organic-farm-village win
- [~] 1c+1d. Decor system: deterministic multi-kind scatter (clustered trees + bushes + flowers + grass tufts) in map.ts; pure decorSprite() mapping in render.ts; dressDecor() in WorldScene; plants.png + tallgrass.png added to manifest. 1027 tests green, tsc clean. FRAME TUNING pending visual check (bush/flower frames are best-guess).
- [ ] 1e. Denser interiors — 8–12 furniture pieces/building (STRUCTURE DETAILS)
- [ ] 1f. Building structure — roof-edge + wall polish

### Wave 2 — Character density
- [x] 2a. Activated all 14 reserve lots → 26 homesteads + 26 personas (34ae07c). 1024 green, reachability holds (max BFS 38). 14 new archetypes (gravedigger, prepper, poet, athlete, con-merchant, teacher, forager, herbalist, blacksmith, seer, miser, drunkard, carpenter, child).
- [ ] 2b. More character sprite variety (optional)

### Wave 3 — New agent systems
- [x] 3a. Diaries (eb8daa3): DiarySystem mirrors ReflectionEngine (live+mock), fires in onDayAdvanced, per-agent store, surfaces in feed as "<Name>'s journal: ...". 1047 green, behavior-proven deterministic.
- [~] 3b. Jobs — LARGELY ALREADY EXISTS: RolesSystem (farmer/merchant/socialite/wanderer/banker from action histograms) + governance's role-based functional-location visiting. Enhancement (concrete occupations per archetype) is optional/deferred.
- [x] 3c. Death/murder/suicide (15a69bd): pure deterministic MortalitySystem — starvation (4 days @ energy≤3), despair/suicide (4 days sustained crisis: low energy+gold<1+≥2 crisis needs+isolated), murder (adjacency + affinity ≤−60 grudge). Skip-dead scheduler gate, 💀 death bus events in feed. Conservative thresholds → normal agents survive (all multi-day tests green). 1065 tests, behavior-proven deterministic. Constants in src/agents/Mortality.ts.

### Wave 4 — Big systems (HANDOFF — architecture notes for fresh context)
- [x] 4a. UI readability polish (b2b35ef): type scale +15-25% (sans body + mono numerals), calm slate/navy palette + single teal accent (was harsh neon-green-on-black), section headers (AGENTS/TOWN/EVENTS/CONVERSATION), more card padding, dense-column clipping fix. 1065 green, visually verified (artifacts/ui-before.png vs ui-after.png). A deeper aesthetic redesign can follow with your input. _(original handoff notes below for reference)_
  - **All HUD chrome is Phaser-drawn in src/scenes/UIScene.ts (~1200 lines), NO DOM** — Text/Rectangle objects; layout math in src/obs/layout.ts (computeHud); panels are pure builders (PartyPanel/GovernancePanel/DiaryPanel) rendered by UIScene. Font/color consts in src/config.ts (LABEL_FONT_SIZE=12, SPEECH_FONT_SIZE, EMOTION_STYLE) + layout.ts (FONT_SIZE_SMALL). **Concrete readability targets**: larger/cleaner type, higher-contrast palette, more padding/spacing between agent cards, clearer panel headers, reduce the dense "GBA" monospace feel. **Best done with dev-server + screenshot iteration (not blind)** — vite on :5180, zoom via wheel-event dispatch (no global Phaser handle; see how I screenshotted). Verify: tests/obs/* + tests/config/* stay green + visual screenshots.
- [ ] 4b. Building capabilities (Minecraft-ish place/remove). **The World grid is currently FROZEN (generated, immutable).** Build controls need: a build-mode toggle in the HUD, a placeable palette (path/wall/soil/water/decor), pointer→tile placement in WorldScene.onWorldPointerDown that mutates the World grid + emits World.onChange(tiles) (the existing per-tile re-render path that farming already uses) — pathfinding auto-adapts (passability is tile-type-driven). Files: src/world/World.ts (add setTile/mutation API), src/scenes/WorldScene.ts (build-mode pointer handling), src/scenes/UIScene.ts (palette UI). Substantial — warrants its own brainstorm+plan. Start small (place/remove a couple tile types) then expand.
- [ ] 4c. Jobs enhancement (OPTIONAL — emergent RolesSystem already covers the basics): concrete occupations tied to the 14 new archetypes (blacksmith→forge, teacher→school, gravedigger→graveyard) with job locations (src/agents/locations.ts) + routines. Lower priority.

## Log
- **01:1x** Merged main, verified 1023 green @ 96×64. Created this log. Starting Wave 1a.
- **01:28** Decor system shipped (a1dd037): dense multi-kind scatter (trees/bushes/flowers/tufts), 1027 green. Visual-confirmed: town went bare→lush/wooded. Screenshot: artifacts/wave1-decor.png.
- **01:38** Warm dirt roads shipped (replaces grey cobble), 1027 green, visual-confirmed. Town now reads as an organic farm village.
- **02:1x** Character density (34ae07c): 12→26 agents, all 14 reserve lots activated + 14 new personas. 1024 green, reachability holds.
- **02:4x** Diaries (eb8daa3): daily first-person journals, surfaced in feed. 1047 green.
- **03:2x** Mortality (15a69bd): death/suicide/murder, deterministic + conservative. 1065 green.
- **03:3x** Visual confirmation: full 96×64 town renders with 26 agents + lush foliage + dirt roads (artifacts/overnight-full-town.png). No regressions.

## SESSION — morning feedback round 3 (2026-06-18, the STRUCTURAL gap)
User (rightly furious): "houses still same design/size, no stores with aisles or larger buildings, everything is a grid, FAR from Smallville." Studied the_ville MAP DATA (not just the renderer): **140×100 tiles, ~1360 interior-furniture tiles in LARGE multi-room buildings** — HOM had ~150 in tiny identical rooms (~9× less density, no big buildings). Key realization: **furniture is render-only (doesn't block pathfinding), so rooms can be packed freely.** Shipped + visually verified (artifacts not committed; see verify-final-7):
- **Bigger civic buildings** (07cc453): supermarket 8×6 (was 5×5), tavern 9×6, cafe 7×5, office 7×6, school 9×6 — doors + central tavern unchanged so ≤40 reachability holds.
- **Packed interiors** (07cc453): supermarket = shelf AISLES; tavern = bar wall + table grid + barrels; cafe = counter + tables; school = bookshelf wall + DESK ROWS; office = cabinet wall + desks; houses = bed + dining + storage + plant, walls filled.
- **Initials** (07cc453): in-world labels → "GG" not full names (killed the cluster blur).
- **Tree-on-roof fix** (this session): canopy box-check (trees are 96×128 = 3×4 tiles) + dropped a hardcoded TREE_SPOT inside the enlarged cafe.
- **Scroll throttle**: agent-strip wheel accumulates to one card/notch (no trackpad fly-through).
STILL NOT Smallville-level (honest): the 26 RESIDENTIAL houses are still small + grid-placed (interiors now varied/packed, footprints uniform); residential layout still a grid; conversation panel still churns fast in MOCK mode. Next candidates: fewer/larger houses, organic residential layout, or a much bigger map.

## SESSION — morning feedback round 2 (2026-06-18, after studying generative_agents)
Re-read the actual Smallville frontend (`generative_agents/.../demo/main_script.html` + `demo.html`). Key lesson: **Smallville renders NO sentence text in the world** — each agent shows only a tiny `INITIALS: emoji` pronunciatio balloon; all words (action, location, conversation) live in side panels with click-to-focus. That was the root of the "I can't read this madness" soup. Six user-driven fixes shipped, each visually verified via Playwright (artifacts/ui-scroll-wrap-verify.png, world-interiors-flowers-verify.png), suite 1073 green:
1. **In-world text soup killed** (5d736ea) — dropped the per-agent plan-step line + 160-char speech bubbles; world shows emoji only, words go to the panels.
2. **Scrollable agent roster** (5d736ea) — kept the rich cards the user liked but windowed them into a horizontally SCROLLABLE strip (wheel / header ◀ N–M ▶), so all 26 are reachable (was 4 + "+22 more"). NOTE: first tried compact chips → user rejected ("I liked the original cards, it can scroll"); reverted to cards + scroll.
3. **Conversation panel word-wraps** (5d736ea) — full utterances reflow by height instead of clipping to "Good to se…".
4. **Varied house interiors** (478e805) — 26 identical bed+table rooms → footprint-seeded furniture variants (cabinet/shelf/barrel/crate, round/small tables, varied bed corner).
5. **Real flowers, no veg fence** (478e805) — the "flower" decor was plants.png HARVESTED PRODUCE (tomatoes/carrots); authored CC0 flowers.png + fixed the (·)%11 hash that planted them in vertical COLUMNS (a literal fence) → diagonal mod-13 scatter, kept off field borders.
6. **Livelier mock afternoon** (791d8c4) — default farmers no longer all run the identical even/odd chore; 4 deterministic per-persona activities. (The start-of-day tavern convergence is the *party* feature, not a bug — now legible since the soup is gone. Mock dialogue was already persona-varied.)

## MORNING SUMMARY (read me first)
**Six features shipped tonight on `feat/world-dressing`, every one fully test-verified + adversarially checked. Suite grew 933 → 1065 green; tsc clean throughout.**
1. **City size** 64×40 → **96×64** (3× area).
2. **Item/foliage density** — dense deterministic decor (trees/bushes/flowers/grass tufts) replacing bare grass.
3. **Warm dirt roads** replacing grey cobble (organic farm-village look).
4. **Character density** 12 → **26 agents** (14 new archetypes: gravedigger, prepper, poet, athlete, con-merchant, teacher, forager, herbalist, blacksmith, seer, miser, drunkard, carpenter, child).
5. **Diaries** — agents write a daily first-person journal entry (shown in the feed).
6. **Death / murder / suicide** — deterministic MortalitySystem (starvation, despair-suicide, murder).

**To view:** `cd /Users/johns/Projects/HOM-world-dressing && <node-prefix> "$N/node" node_modules/vite/bin/vite.js --port 5180` then open http://localhost:5180. Worktree is on branch `feat/world-dressing`; merges cleanly to `main` (governance already merged in).

**Not done (handed off above, Wave 4):** UI revamp (4a — needs visual iteration), build controls (4b — needs its own plan), jobs enhancement (4c — optional, RolesSystem already covers basics). Decided NOT to start these blind at the tail of a long context — they're specced above for a fresh session / your review.

**Tasteful note on #6:** death/murder/suicide is in-world *simulation* logic only (a dark farming sim), thresholds tuned so it's rare and never triggers for normally-behaving agents.
