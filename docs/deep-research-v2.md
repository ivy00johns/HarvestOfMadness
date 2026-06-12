# Building an LLM-Native Farming Sim in Phaser 4: Asset Pipeline + Generative-Agents NPC Architecture

## TL;DR
- **Assets:** No single CC0 pack covers crop growth-stages + shoreline-transition water + a 4-directional *animated* character, so the best **redistributable** default is the **Liberated Pixel Cup (LPC) ecosystem** (32×32, dual-licensed CC-BY-SA 3.0/GPL-3.0, with some CC0/OGA-BY parts) — it is purpose-built to live in public Git repos and covers every category. Use **Kenney CC0 packs** for terrain/buildings/UI where you want zero attribution burden. **Do NOT bundle "Sprout Lands"** — its license forbids redistribution even if modified.
- **Rendering:** Build the map in **Tiled**, export embedded-tileset JSON, load with `load.tilemapTiledJSON` + `addTilesetImage` + `createLayer`, set collision from a layer/tileset property, animate water tiles manually, depth-sort NPCs by Y, and follow the player with `cameras.main.startFollow`. Phaser 4 (v4.0.0 "Caladan," released 10 April 2026) keeps the v3 tilemap/sprite API almost unchanged (only custom WebGL pipelines break).
- **NPCs:** Reimplement the Stanford **generative-agents** loop (memory stream → retrieval by recency/importance/relevance → reflection → daily planning → reaction) but run it **off the render loop** on a tick budget, use a **tiered model router** (cheap model for routine actions, better model for dialogue/reflection), constrain actions with **JSON-schema function-calling**, and design a **rich enough world** that the LLM's intelligence is load-bearing rather than cosmetic.

## Key Findings

### Part 1 — Assets & rendering
1. **Sprout Lands (Cup Nooble)** is the closest visual match to Stardew but is **download-only / non-redistributable**. Its license file states the pack "can't be used in any commercial project, resold/redistributed, even if modified," and credit to "Cup Nooble" is required for the free pack. You may make a game with it but you may **not** ship the raw assets in a public repo. This disqualifies it for your bundling requirement.
2. **Kenney packs are true CC0** ("CC0 1.0 Universal… no need to ask permission… giving attribution is not required") and the safest legal choice, but Kenney's top-down **Roguelike Characters are explicitly *not* animated** ("True roguelike characters don't have animations!"), and Kenney offers no multi-stage crop-growth sprites or shoreline-transition animated water. So pure-Kenney can't deliver an animated farmer + growing crops without supplementation.
3. **The LPC ecosystem** covers 100% of the requested categories with a consistent 32×32 style and is explicitly built for redistribution (it already lives in public GitHub repos):
   - **[LPC] Crops** by bluecarrot16 — 5-frame growing animations for 50 crops — CC-BY-SA 4.0 / CC-BY-SA 3.0 / GPL-3.0 (some sprites additionally CC0).
   - **[LPC] Farming tilesets** by Daniel Eddeland — wheat/grass/sand/fence tilesets, market stalls, props — CC-BY-SA 3.0 OR GPL-3.0; "Please attribute creator as Daniel Eddeland… include a link to opengameart.org."
   - **[LPC] Terrains** by bluecarrot16 — seamless grass/dirt/rock/stone/water/snow with transition/edge tiles — CC-BY-SA.
   - **LPC Animated Water and waterfalls** by ZaPaper — land↔water transition tiles + waterfalls — CC-BY-SA 3.0 + GPL-3.0.
   - **Universal LPC Spritesheet Character Generator** — 4-directional walk/slash/thrust/cast/shoot/hurt (expanded fork adds idle/run/jump/climb/sit), 64×64 frames, mix-and-match bodies/hair/clothing to make many distinct NPCs — GPL-3.0 and/or CC-BY-SA 3.0.
4. **The cost of LPC** is ShareAlike/copyleft (derivative art must stay under the same license) plus a mandatory **CREDITS file** listing every author, license and source URL, made accessible to end users. CC-BY-SA 3.0's anti-DRM clause is irrelevant to GitHub redistribution but matters for encrypted app-store builds — prefer OGA-BY or CC0 parts there.
5. **Cute Fantasy RPG (Kenmi)** is a high-quality 16×16 Stardew-like with farming tiles, animated water, customizable characters and 8 premade NPCs, but its license forbids redistributing the raw assets ("you cant buy one copy and then send it to ten other people"), so it is fine for a *closed* game build but not for bundling in a public repo.
6. **Phaser 4** — v4.0.0 "Caladan" released **10 April 2026** — is, per phaser.io, "a ground-up rebuild of the WebGL renderer with a completely new architecture, while keeping the API you know and love." Sprites, text, tilemaps, input, Arcade/Matter physics, cameras, tweens, audio are "likely unchanged." Breaking changes hit only custom WebGL pipelines/shaders, FX/Masks (now unified "Filters"), `setTintFill`, `Geom.Point`, `Math.TAU`, and removed Mesh/Plane objects.

### Part 2 — Generative-agents NPC architecture
7. The Stanford architecture (Park et al., UIST 2023, arXiv:2304.03442) has three components on top of an LLM: **memory stream**, **reflection**, **planning**, plus a **retrieval** function and a **reaction** loop. Per Park et al., "The current implementation utilizes the gpt3.5-turbo version of ChatGPT" and "A community of 25 unique agents inhabits Smallville," producing emergent behavior (e.g., agents autonomously organizing a Valentine's party).
8. **Retrieval score = recency + importance + relevance**, each normalized to [0,1] and (in the paper) equally weighted. Per Park et al.: "we treat recency as an exponential decay function over the number of sandbox game hours since the memory was last retrieved. Our decay factor is 0.995." Importance = LLM-rated 1–10 poignancy at write time; relevance = cosine similarity between the query embedding and the memory embedding. Top-k that fits the context window is injected.
9. **Reflection** fires when summed importance of recent events crosses a threshold (≈2–3×/day): take ~100 recent memories, ask the LLM for the "3 most salient high-level questions," retrieve memories for each, then ask for "5 high-level insights" with citations to the source memory IDs. Reflections are themselves memories and can be reflected on recursively.
10. **AI Town (a16z-infra)** is the canonical MIT-licensed TS/JS reimplementation: Convex backend (DB + vector search + simulation engine), PixiJS rendering. Per its README, "Default chat model is llama3 and embeddings with mxbai-embed-large… Configurable for other cloud LLMs: Together.ai or anything that speaks the OpenAI API." Its engine runs the simulation **at 1 step/sec, batching many "ticks" per step**, single-threaded per world to avoid race conditions, and keeps chat messages *out* of the core game state for latency. Per the README, "We used https://github.com/pierpo/phaser3-simple-rpg for the original POC of this project. We have since re-wrote the whole app."
11. **Cost control is the central deployment problem.** Park-style simulation of 2–3 agents costs "several dollars per hour"; cost grows linearly with interactions, "unacceptable… when LLM agents are to be used as NPCs in an open world." **Affordable Generative Agents (AGA, arXiv:2402.02053, Yu et al., TMLR 08/2024)** cuts this to **31.1% of baseline tokens**: "the cost of using only the Lifestyle Policy is 40.2% of the original, while using only the Social Relationship Memory is 58.6%, and the full AGA framework is 31.1%" — via (a) replacing repetitive agent-environment LLM calls with **learned/cached "lifestyle policies"** and (b) compressing inter-agent dialogue with a **social-relationship memory**. **Lyfe Agents (Kaiya et al., arXiv:2310.02172)** "enabled Lyfe Agents to operate at a computational cost 10-100 times lower than existing alternatives" via an **option-action hierarchy** (cheap high-level choices), **asynchronous self-monitoring**, and a **Summarize-and-Forget** memory; ablating either self-monitoring or SaF memory sharply hurt performance.
12. **Structured output / function-calling** is the reliable way to constrain an LLM to a valid game action set: provide a JSON Schema with `enum`-restricted actions, use provider strict modes (OpenAI `strict:true`, Anthropic tool use, or constrained decoding via Outlines/grammars for local models). Production agents using structured output report ~95–99% action-success vs 70–85% for text-parsing; on validation failure, retry with the error message in the prompt (2–3 retries) then degrade gracefully.
13. **The anti-pattern that makes LLM NPCs pointless:** AGA showed agents "can only generate finite behaviors in fixed environments" — if the action space is tiny or the world is small, the optimal move is obvious and a state machine would behave identically. Believability/intelligence is only *visible* when the world is rich (many interactable objects, many social relationships, many goals).

## Details

### 1. Recommended asset stack

**Best default (redistributable, complete): the LPC ecosystem.** It is the only freely-licensed option that covers terrain (incl. tilled soil + path), shoreline/edge-transition + animated water, town buildings, trees/foliage, multi-stage crops, and a 4-directional *animated* character with many variants — all in one consistent 32×32 style, already distributed via public Git repos. Assemble:
- Characters: **Universal LPC Spritesheet Character Generator** (GitHub: LiberatedPixelCup fork). Generate one sheet per NPC; mix bodies/hair/clothes for distinct personalities. 4 directions; walk is an 8-frame cycle; 64×64 frames.
- Terrain + water: **[LPC] Terrains** + **LPC Animated Water and waterfalls**.
- Farming: **[LPC] Farming tilesets** (Eddeland) + **[LPC] Crops** (5 growth frames × 50 crops).
- Buildings/trees: bluecarrot16's LPC building sets + **LPC Fruit Trees**.
- **License obligations:** treat the whole bundle as **CC-BY-SA 3.0** (the common denominator). Ship a `CREDITS.txt` enumerating every author/license/URL; keep your derivative art under CC-BY-SA; include the license texts. This is fully compatible with a public repo.

**Alternative A (zero-attribution, but supplement needed): Kenney CC0.** Use Kenney's **Roguelike/RPG Pack** (1,700+ tiles, 16×16), **RPG Urban Pack** (480 assets, 6 characters in 4 directions *with* walking animations — note this Kenney pack DOES animate, unlike Roguelike Characters), and **Map Pack** for terrain/buildings. CC0 means no attribution and no share-alike. Gap: still thin on multi-stage crops and shoreline-animated water, which you'd hand-author or pull from LPC.

**Alternative B (closed build only): Cute Fantasy RPG (Kenmi)** or **Sprout Lands (Cup Nooble)** — both are the strongest Stardew-likes visually and cheap/free, but **neither can ship in a public repo**. Use these only if you keep assets out of the public repo (e.g., a private assets submodule or a built/obfuscated distribution).

### 2. Phaser 4 + Tiled pipeline

**Tiled setup.** Build one large orthogonal map (e.g., 100×100+ tiles). Use separate tile layers for draw order: `Ground` → `GroundDecor` → `Paths` → `Buildings` → `Overhead` (drawn above the player). Put a `Collisions` object/tile layer for solids. When exporting: **embed the tileset in the map**, keep layer data **uncompressed (CSV or Base64-uncompressed)**, export **JSON**. Critical Phaser constraint: the parser **does not support Tiled "Collection of Images" tilesets** — every layer's tiles must come from a **single tileset image**.

**Loading (Phaser 4, same API as v3):**
```js
preload() {
  this.load.image('tiles', 'maps/lpc_terrain.png');
  this.load.tilemapTiledJSON('farm', 'maps/farm.json');
  this.load.spritesheet('npc_abigail', 'chars/abigail.png',
    { frameWidth: 64, frameHeight: 64 });
}
create() {
  const map = this.make.tilemap({ key: 'farm' });
  const tileset = map.addTilesetImage('lpc_terrain', 'tiles'); // name must match Tiled
  const ground = map.createLayer('Ground', tileset, 0, 0);
  const buildings = map.createLayer('Buildings', tileset, 0, 0);
  const overhead = map.createLayer('Overhead', tileset, 0, 0);
  overhead.setDepth(1000); // render above characters
}
```

**Collision.** Two common approaches: (a) `ground.setCollisionByProperty({ collides: true })` after marking tiles in Tiled's tileset editor; or (b) a dedicated layer with `setCollisionByExclusion([-1])`. Then `this.physics.add.collider(player, buildings)`. Visualize with `map.renderDebug`.

**Animated water.** Phaser's Tilemap API does **not** natively play Tiled's per-tile animations, so iterate the water layer and swap tile indices on a timer (a `time.addEvent` loop cycling frames), or convert water to sprites. This is a well-documented community pattern.

**Depth sorting.** For a top-down game, set each character's depth to its `y` (`sprite.setDepth(sprite.y)`) every frame so NPCs/player occlude correctly with each other; keep the `Overhead` layer at a fixed high depth for roofs/treetops.

**Camera over a large map.** `this.cameras.main.setBounds(0,0, map.widthInPixels, map.heightInPixels); this.cameras.main.startFollow(player, true, 0.1, 0.1);` and `this.physics.world.setBounds(...)`. Use `pixelArt: true` + `roundPixels: true` in game config and integer zoom to keep pixels crisp.

**Character animations.** Define 4 directional walk anims from the spritesheet:
```js
this.anims.create({ key: 'abigail-walk-down',
  frames: this.anims.generateFrameNumbers('npc_abigail', { start: 0, end: 7 }),
  frameRate: 10, repeat: -1 });
```
LPC rows map to directions (up/left/down/right). In `update`, pick the anim by movement vector and `stop()` on idle.

**Phaser 4 specifics.** Use WebGL (Canvas is deprecated). Standard tilemap/sprite/camera/physics code from v3 tutorials works unchanged. If you copied any custom shader/pipeline or used `setTintFill`/`Geom.Point`/`Math.TAU`/FX/Masks, port them to render-nodes/Filters/`setTint`+`setTintMode`. There is also an optional GPU tilemap layer (orthographic only) and `SpriteGPULayer` for huge sprite counts.

### 3. Generative-agents architecture adapted to a Phaser farming sim

**Process boundary.** Run the agent "brains" **outside** the Phaser render loop. Mirror AI Town: a server (or web worker / async scheduler) advances agent cognition on a slow cadence (e.g., one simulation step per second, or per in-game 10-minute block), batching decisions; Phaser only reads the resulting intents and animates movement at 60fps. This guarantees the LLM never blocks rendering.

**Per-NPC state (the memory stream).** Store an append-only list of memory objects: `{ id, type: observation|reflection|plan, text, created_at(game-time), last_access, importance(1–10), embedding }`. Back it with a vector index (in TS, AI Town uses Convex vector search; a lightweight option is an in-memory cosine index or sqlite-vec, embeddings from your FreeLLMAPI/Ollama `mxbai-embed-large`).

**Retrieval (per decision).** `score = w_rec·decay(0.995, hoursSinceAccess) + w_imp·(importance/10) + w_rel·cosine(queryEmb, memEmb)`, normalize each term to [0,1], start with equal weights, take top-k (3–7). Tune: half-life in the tens of game-hours; too-high relevance → repetitive recall, too-high recency → no long-term continuity.

**Reflection (2–3×/game-day).** When summed importance of recent observations crosses a threshold, prompt the (better) model: "Given these statements, what are the 3 most salient high-level questions?" → retrieve → "What 5 high-level insights can you infer? (cite source memories)". Store insights as `reflection` memories. This is what lets Abigail conclude "the player keeps giving me amethysts → they may like me" rather than just logging gifts.

**Daily planning + reaction.** Each morning, generate a coarse plan (a schedule of goals/locations) from the agent's persona summary + recent reflections, then decompose into hourly/finer actions on demand. During the day, on each observation decide *continue plan* vs *react*; regenerate the remainder of the plan from the reaction point. This produces autonomous routines that visibly differ per character.

**Action schema (function-calling).** Constrain every decision to a validated action set, e.g.:
```json
{ "name": "npc_action", "parameters": { "type": "object",
  "properties": {
    "action": { "enum": ["walk_to","talk_to","use_object","plant","water","harvest","give_gift","wait","emote"] },
    "target": { "type": "string" },
    "utterance": { "type": "string" },
    "emotion": { "enum": ["neutral","happy","annoyed","sad","excited"] }
  }, "required": ["action"] } }
```
Use OpenAI `strict:true` / Anthropic tool use / Outlines-grammar for local models. **Validate against world state** (is `target` reachable/adjacent/owned?); on invalid or schema-fail, retry once with the error appended, then fall back to `wait`. Feed the executed result back as a new observation. This closes the perceive→decide→act→observe loop.

**The four "undeniably AI" dimensions, made visible:**
- **(a) Dialogue & distinct personality:** persona block (name, traits, speaking style, backstory, current goal) + retrieved memories + recent dialogue window (last ~10 turns) → better model generates the line via the `utterance` field. Distinctness emerges because each NPC's persona + private memory differ. *Surface it:* speech bubbles, and let players ask open questions that no script anticipated.
- **(b) Relationships & social memory over time:** store per-pair relationship summaries (AGA's "social relationship memory") updated after each interaction; gifts/insults/help become high-importance memories that bias future retrieval and dialogue tone. *Surface it:* a visible affinity meter that the NPC can *explain in its own words* ("you helped repair my fence, so…").
- **(c) Autonomous routines/schedules/goals:** the daily-planning module gives each NPC a self-authored schedule that adapts to events (rain, festival, a death). *Surface it:* NPCs are found in different believable places/activities each day; a "what are you doing?" query returns the LLM's actual current plan step.
- **(d) Emergent, non-scripted decisions:** reaction + reflection let NPCs start unplanned conversations, change goals, spread information NPC-to-NPC (information diffusion), and coordinate (the Smallville party). *Surface it:* gossip propagation — tell one NPC a secret and others learn it only through in-world conversations.

**The kill-switch test (your core requirement).** Because routines, dialogue, relationship reasoning and reflections all flow through the LLM router, disabling the provider should visibly degrade the world: NPCs fall back to `wait`/static schedules, dialogue becomes canned, relationships stop evolving, and no emergent events occur. Make this explicit by routing *all four* dimensions through the LLM (not just dialogue), so the dependency is genuine, not cosmetic.

### 4. Cost & latency engineering (so many NPCs stay affordable)
- **Tier the router (your FreeLLMAPI fits perfectly):** route routine/option-level decisions and importance scoring to the cheapest/local model (Ollama llama3-class); route dialogue, reflection and daily planning to a stronger model. This is exactly Lyfe Agents' option-action split.
- **Cache "lifestyle policies" (AGA):** the first time an NPC decides a recurring situation ("morning at the farm → water crops"), store the decision and **replay it** instead of re-querying; only call the LLM on novel states. This drove AGA to 31.1% of baseline cost; a 60fps robotics analogue ("Body-Push"/pattern-store) only pings the LLM on a cache-miss.
- **Asynchronous scheduling:** stagger NPC heartbeats (e.g., one bounded-autonomy system uses a 40-second behavior heartbeat per character, plus event-triggered wakeups); never run all NPCs in the same tick. Run cognition off-thread and apply results when ready (results cached until next encounter).
- **Summarize-and-forget memory (Lyfe):** periodically compress old low-importance observations into summaries and drop raw rows, keeping prompts (and vector tables) small. AI Town similarly advises (per its README) "you might want to set NUM_MEMORIES_TO_SEARCH to 1 in constants.ts, to reduce the size of conversation prompts, if you see slowness."
- **Trim prompts:** window dialogue history (~10 exchanges), keep a separate long-term fact store, and stream tokens so the first words appear fast (target <500ms perceived latency for dialogue).
- **Guardrails:** per-agent rate limits/budget caps and moderation hooks on generated utterances (as AI Town ships) to prevent runaway spend and unsafe output.

### 5. Anti-patterns to avoid
- **Action space so small the optimal move is obvious** — if NPCs can only "walk" and "talk," a state machine is indistinguishable from an LLM. Give many verbs and many objects.
- **World too small/static for emergence** — AGA proves agents produce only *finite* behaviors in fixed environments. Provide many interactable objects, locations, items, weather/seasonal events, and inter-NPC relationships so plans and gossip actually branch.
- **Decisions a state machine would make identically** — reserve the LLM for genuinely open choices (who to befriend, how to react to a loss, what to say); don't spend tokens deciding pathfinding.
- **LLM in the hot loop** — never await an LLM call inside `update()`. Decision latency must be hidden by async scheduling + animation.
- **Dialogue-only "AI"** — if only speech is generative but schedules/relationships are scripted, disabling the LLM barely changes the game, defeating your premise. Route routines, social memory and reflection through the model too.
- **Unconstrained text actions** — free-text parsing yields 70–85% success and frequent invalid actions; always use schema/function-calling + validation + retry.
- **Memory that never forgets** — unbounded memory inflates cost and latency and pollutes retrieval; cap top-k at 3–7 and summarize-and-forget.

## Recommendations

**Stage 0 — Prototype (1–2 weeks).** Stand up Phaser 4 (WebGL, `pixelArt:true`) with a Tiled map using **Kenney CC0** tiles (no license friction) and the **Kenney RPG Urban Pack** animated 4-direction characters as placeholders. Get camera-follow, collision, depth-sort, and one walking NPC working. In parallel, fork **AI Town** to study the Convex engine/step loop even if you don't keep Convex.

**Stage 1 — One genuine agent.** Implement the memory stream + retrieval + function-calling action loop for a single NPC via FreeLLMAPI, running off-loop on a 1s step. Verify the kill-switch: disabling the provider makes the NPC freeze/canned.

**Stage 2 — Visible AI on all four dimensions.** Add reflection, daily planning, and per-pair relationship memory. Build the surfacing UI (speech bubbles, affinity meter the NPC can explain, "what are you doing?" query). Swap art to the **LPC ecosystem** for the real animated farmer + growth-stage crops + shoreline water; add `CREDITS.txt` and CC-BY-SA license texts to the repo.

**Stage 3 — Scale to a town affordably.** Add the tiered router, lifestyle-policy caching, staggered heartbeats, and summarize-and-forget. Add rate-limit/budget caps and utterance moderation.

**Benchmarks / thresholds that change the plan:**
- If per-hour LLM cost exceeds budget at N NPCs → push more decisions to the cached lifestyle-policy path and the local model; raise heartbeat interval.
- If dialogue latency >500ms perceived → stream tokens, shrink the history window, precompute idle "small talk."
- If action-validation failure rate >5% → tighten the JSON schema/enums and add a second retry; consider grammar-constrained decoding for the local model.
- If players say NPCs feel "scripted" → expand the action space and the number of interactable objects/relationships (the emergence lever), not the model size.
- If you later need a closed app-store build with DRM → switch LPC parts to their OGA-BY/CC0 equivalents to avoid CC-BY-SA's anti-DRM clause, or license Cute Fantasy/Sprout Lands for the closed build.

## Caveats
- **License specifics change** — re-read each pack's current license file before shipping; Sprout Lands and Cute Fantasy explicitly forbid redistributing raw assets, and LPC's per-asset licenses vary (some CC0/OGA-BY, most CC-BY-SA/GPL) so the CREDITS file must be built per asset actually used.
- **Phaser 4 is recent** (final v4.0.0 "Caladan" released 10 April 2026); some third-party plugins and tutorials still target v3. The core tilemap/sprite/camera APIs are stable, but verify any plugin's v4 support.
- **Cost figures are research-context** (e.g., "several dollars/hour" for 2–3 Park agents, AGA's 31.1%, Lyfe's 10–100×) and depend heavily on model choice, prompt size and interaction frequency; treat them as directional, and measure your own with FreeLLMAPI's actual providers.
- **Free-tier API pooling adds reliability risk** — rate limits and provider outages can stall NPC cognition; the async/cached design degrades gracefully, but plan a local-Ollama fallback so the world keeps moving.
- **Believability ≠ correctness** — LLM NPCs occasionally make incoherent choices (Lyfe noted multi-step reasoning can fail on GPT-3.5-class models); schema validation and reflection reduce but don't eliminate this.
