# Emergent Role Specialization — Implementation Spec (Wave 4a)

> First of three sequential cognition-deep Wave-4 features (roles → gossip → governance). Builds on shipped goal-gen. Additive + fire-and-forget + mock-deterministic + no global tick. Suite 885 green → **895+ green + `tsc` clean**.

## Ground truth
- `Agent.role` = `readonly role = "farmer"` (src/agents/Agent.ts:33); read in Observation.ts:127 (→ obs.self.role) + round-tripped mock.ts:202; decision never branches on it. Must drop `readonly` so Cognition sets it.
- Goal-gen pattern to mirror (shipped): NeedsSystem/GoalsSystem are additive subsystems wired in Cognition as `readonly needs`/`readonly goals`, fed in recordOutcome (Cognition.ts:381 `needs.onOutcome`), pulsed in onDayAdvanced (629-651), surfaced in enrichObservation (681-693). dominantDrive(needs) is deterministic argmax.
- Party kill-switch (party-emergence.test.ts): NO drive/role may pull ≥3 agents to the tavern absent a seeded event (asserts <3 near tavern + knowerCount 0). Role bias MUST be dispersive/farm-local, never tavern-convergent.

## 1. Role model — NEW `src/agents/Roles.ts`
- Vocabulary `["farmer","merchant","socialite","wanderer","banker"] as const` → `DerivedRole`. farmer = default/seed/fallback.
- `ACTION_ROLE_BUCKET`: TILL/PLANT/WATER/HARVEST→farmer; BUY/SELL→merchant; TALK_TO/GIVE_GIFT→socialite; MOVE_TO/USE_OBJECT→wanderer. WAIT/EMOTE/SLEEP absent (ignored).
- `banker` = state overlay: gold≥`BANKER_GOLD_THRESHOLD`(400) AND merchant bucket top-or-≥farmer.
- Tuning: `ROLE_WINDOW=24`, `ROLE_MIN_SAMPLE=8` (below → stay "farmer"), `ROLE_HYSTERESIS_MARGIN=0.15` (candidate must lead current by this share of window to flip), `ROLE_PRIORITY=["farmer","merchant","socialite","wanderer"]` (argmax tie-break, farmer-first). `DEFAULT_ROLE="farmer"`.
- `RolesSystem`: per-agent FIFO window (string[] cap N) + current role map. `onOutcome(agent, action, result)` pushes kind only when `result.ok===true` AND kind∈ACTION_ROLE_BUCKET. `derive(name, gold)` PURE (buckets from window, banker overlay, MIN_SAMPLE→farmer, argmax+priority); does NOT mutate. `update(agent)` = hysteresis gate (flip current only past margin), the only mutator, reads agent.gold; returns role. `role(name)` cheap sync read. All methods defensive (never throw), deterministic (integer counts, no Math.random/Date.now).

## 2. Cognition wiring (additive, defensive — mirror needs/goals)
- Field `readonly roles = new RolesSystem();` next to `needs`.
- recordOutcome: `try { this.roles.onOutcome(agent, action, result); } catch {}` next to needs.onOutcome, BEFORE the GIVE_GIFT early-return (so gifts count toward socialite).
- onDayAdvanced (per-agent loop, after needs): `try { agent.role = this.roles.update(agent); } catch {}` — once/game-day cadence, synchronous, no LLM.
- enrichObservation (after needs block): `const role = this.roles.role(agent.name); obs.self.role = role; agent.role = role;` — reads CACHED role (synchronous, deterministic, no hot-path re-derive).

## 3. Agent.ts
Line 33 → `role: DerivedRole = "farmer";` (mutable, typed; import DerivedRole). personas.ts NOT touched (no seed needed; prose hints already bias behavior via plan/ladder keywords → histogram).

## 4. Decision biasing (deterministic, non-convergent)
- prompts.ts buildUserPrompt: gated section AFTER relationships, ONLY when `obs.self.role && obs.self.role !== "farmer"`: "YOUR EMERGENT ROLE: the town sees you as a {role}… let it color your choices when nothing more urgent presses." Advisory (never overrides). Default-role agents → byte-identical prompt.
- mock.ts decide(): a single LOW-priority role-bias branch in the FINAL "nothing pressing" slot (mock.ts:682-711, same slot as social flavor), AFTER the entire farm ladder + event ATTEND/INVITE. Gated `self.role && self.role !== "farmer"`. Nudges: merchant/banker → if holding crops + shop visible + not adjacent, MOVE_TO(shop) (normal economic dest, lets SELL fire next); socialite → chat ADJACENT (Chebyshev≤1) neighbor only, gated `seed%3===0` (no convergence); wanderer → MOVE_TO a nearby non-occupied tile (dispersive); farmer → no bias. Uses existing `seed=hash(name:day)` (no RNG). NONE target the tavern or move agents toward each other → kill-switch safe.

## 5. Contracts (additive)
`ROLE_VOCABULARY`/`DerivedRole` const+type near NeedState. `Observation.self.role` STAYS `string` (no narrowing → no breaking callers); add Wave-4a doc comment. `AgentCardModel.role?: string` (additive). Brief note in contracts/README.md (already dirty). NO role-confidence/histogram surfacing (keep minimal, avoid gossip/governance collision).

## 6. Inspector/HUD (additive)
- Inspector.ts: `InspectableAgent.role?: string`; in buildAgentCard after needs: `if (typeof agent.role==="string" && agent.role.length>0) card.role = agent.role;`.
- UIScene.ts updateCard: append role to name only when non-default: `const roleTag = card.role && card.role!=="farmer" ? \` · \${card.role}\` : ""; ui.name.setText(this.clip(\`\${card.name}\${roleTag}\`, 22));`. No new Text object.

## 7. Tests
NEW `tests/agents/roles.test.ts` (pure-model, ~10 cases): vocabulary+bucket map; derivation (sell-heavy→merchant, harvest→farmer, talk→socialite, move→wanderer); banker overlay (gold gate); MIN_SAMPLE guard (→farmer); determinism (run()===run() deep-equal); hysteresis/no-thrash (a few off-role actions don't flip; only sustained margin flips); failed results ignored; rolling eviction (>WINDOW); malformed input no-throw; role-influences-mock-decision (merchant obs → MOVE_TO shop, farmer obs → plain WAIT, socialite w/ no adjacent neighbor → NO convergence move, same-obs-twice identical).
CONFIRM green (no edit): needs/goals/needs-goals-degrade, planner (4-step), party-emergence (kill-switch + convergence), mock-determinism/parse, cognition-runtime/integration, observation (role still string). ADD a small assertion in cognition-runtime: after cycles + day-advance, agent.role ∈ ROLE_VOCABULARY and obs.self.role surfaced; do NOT assert a specific non-farmer role on day 1 (insufficient sample).

## 8. Ownership (Wave 4a owns)
src/agents/Roles.ts (new), src/agents/Agent.ts, src/agents/Cognition.ts, src/llm/prompts.ts, src/llm/mock.ts, contracts/types.ts (additive), contracts/README.md (note), src/obs/Inspector.ts, src/scenes/UIScene.ts, tests/agents/roles.test.ts (new) + minor cognition-runtime assertions. personas.ts NOT touched. HANDOFF: gossip (next) extends Cognition.onTalk gossip block + buildUserPrompt (append AFTER role section) + mock TALK_TO branch (earlier opportunistic-spread slot, not the final slot roles uses) + contracts; governance (last) shares onDayAdvanced loop (add its line after roles') + contracts + consumes DerivedRole. Land roles FULLY (tests green) before gossip edits the shared files.

## 9. Risks
1. Role thrash → hysteresis margin + MIN_SAMPLE + window smoothing; no-thrash test. 2. Mock non-determinism → hash(name:day) seed, gated !==farmer (default byte-identical), final-slot only; same-obs-twice test + full mock-determinism suite. 3. Town convergence/kill-switch → no nudge targets tavern/moves-toward; merchant→shop, wanderer→dispersive, socialite→adjacency-only; re-run party-emergence. 4. Break goal-gen → separate additive subsystem beside needs/goals, own try-wrap, never touches needs/goals state. 5. Contract/tsc breakage → Observation.self.role stays string; all new fields optional; planner/mock-plan untouched; tsc clean.
