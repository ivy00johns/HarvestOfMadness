# Needs-Driven Goal Generation (PIANO Keystone) — Implementation Spec

> Wave 3a. Makes `Agent.goal` dynamic: intrinsic drives → synthesized goals → goal-conditioned plans. Strictly ADDITIVE + fire-and-forget + mock-fallback. Suite is 834 green; bar after ≈ **834+ green + `tsc` clean**. Frozen invariants (planner 4-step, reflection 30, retrieval formula, mock-determinism, affinity, party-emergence, conversation) MUST stay green.

## Ground truth
- `Agent.goal` set only transiently from the LLM action (`AgentRuntime.ts:229`); starts null; persona "starting goal" lives only in prose. No drives, no re-derivation.
- Cognition hook order in `enrichObservation` (`Cognition.ts:597`, one try/catch): ensurePlan → planner.advance → currentStep → relationships → retrieval → nearby/events. `onDayAdvanced` (`Cognition.ts:586`) loops agents calling ensurePlan — the morning cadence hook. `recordOutcome` (`Cognition.ts:338`) is the rule-9 outcome hook.
- Planner: `coercePlanSteps` forces exactly 4 phase-ordered steps; `mockDailyPlan` (`mock.ts:805`) fallback. Mock determinism = djb2 `hash(name:day)`, NO Math.random/Date.now. Mock plan-intent follower (`mock.ts:384+`) routes by plan-step KEYWORDS → so goals steer behavior via plan-step text, no new decision branch.
- Observation additive-optional-field pattern: `currentPlanStep?/relationships?/knownEvents?` surfaced only when present, round-tripped defensively in `normalizeObservation` (`mock.ts:198`).

## 1. Drives — NEW `src/agents/Needs.ts`
5-drive vector, each `[0,1]`, higher = more pressing (so dominant = argmax):
```ts
export interface NeedState { energy: number; wealth: number; social: number; novelty: number; purpose: number; }
export const DRIVE_KEYS = ["energy","wealth","social","novelty","purpose"] as const; // also tie-break order
export const NEEDS_BASELINE: NeedState = { energy:0, wealth:0.5, social:0.3, novelty:0.3, purpose:0.5 };
// tuning (pinned): WEALTH_COMFORT_GOLD=500, SOCIAL_DECAY_PER_PHASE=0.12, NOVELTY_DECAY_PER_PHASE=0.10,
// PURPOSE_REGEN_PER_DAY=0.4, SOCIAL_REFILL=0.5, PURPOSE_REFILL=0.35, NOVELTY_REFILL=0.4
```
**Event-sourced, NO global tick:**
- `recomputeFromState(agent)` (derive-on-read): `energy=clamp01(1-agent.energy/ENERGY_START)`; `wealth=clamp01(1-agent.gold/WEALTH_COMFORT_GOLD)`.
- `onOutcome(agent, action, result)` (refill on ok): TALK_TO/GIVE_GIFT→social−=SOCIAL_REFILL; HARVEST/SELL→purpose−=PURPOSE_REFILL; action kind ≠ previous → novelty−=NOVELTY_REFILL else novelty+=NOVELTY_DECAY. Failed results don't refill.
- `onDayAdvanced(name)`: social/novelty += per-phase×4; purpose += PURPOSE_REGEN_PER_DAY; all clamped.
- `NeedsSystem`: `Map<string,NeedState>`; `state()` returns defensive copy (lazy baseline); `dominant(name)` = argmax, tie-break in DRIVE_KEYS order. All methods never throw. `clamp01` exported for tests.

## 2. Goal synthesis — NEW `src/agents/Goals.ts`
`GoalsSystem` with `Map<string,{day,text,drivenBy}>` cache + per-(agent,day) inflight guard (mirror Planner.inflight).
- **Cadence (NOT per-decision):** refresh on (a) new-day morning (force), (b) a drive crossing `DRIVE_URGENT=0.75` into a NEW dominant drive (differs from cached `drivenBy`). Else return cache.
- **Mock** `mockGoal(persona, needs, day)` in `mock.ts`: dominant drive → template whose KEYWORDS land in the mock plan follower vocabulary: energy→"rest…sleep…home"; wealth→"sell…market"; social→"socialize…tavern"; novelty→"wander…stroll"; purpose→"till/plant/water…farm". Persona/day variety via `hash(persona:day)%N` (2–3 phrasings). Deterministic argmax shared with `Needs.dominant`.
- **Live** `buildGoalPrompt(persona, needs, topMemories)` in `prompts.ts`: smart-tier, PLAIN-TEXT one line (no JSON), drives sorted desc + memories, "one sentence ≤15 words". `refresh` live path: router(tier:smart); on error/empty/over-long → `mockGoal`. Sanitize to one line ≤120 chars.
- `current(name)` = cheap sync cached read (null until first refresh).

## 3. Plan conditioning WITHOUT breaking 4-step shape
- `PlannerDeps.goalOf?: (name)=>string|null` (optional → existing tests' harness unaffected). Live: inject `YOUR CURRENT GOAL: <goal>` block into `buildDailyPlanPrompt`; `coercePlanSteps`/`PHASE_ORDER.map` UNTOUCHED. Mock: `mockDailyPlan(persona, day, goal?)` re-weights afternoon/evening branch by goal keyword; **morning stays farm-ish, night ALWAYS bed/sleep** (preserves planner.test 4-step + night-at-bed). Goal only re-weights existing branches; never adds/removes steps. Existing callers pass no goal → byte-identical output (mock-daily/mock-v2 green).

## 4. Cognition wiring (additive, each call try-wrapped/void-catch)
- Constructor: `readonly needs = new NeedsSystem()`; `goals = new GoalsSystem({live,router,now,persona,needs:(n)=>needs.state(n),topMemories,onLiveCall:()=>metrics.goalCalls++})`. Add `goalCalls:number` to `CognitionMetrics` (+init 0).
- Planner deps: `goalOf:(n)=>goals.current(n) ?? agents.get(n)?.goal ?? null`.
- `recordOutcome`: `try { needs.onOutcome(agent,action,result); } catch {}`.
- `onDayAdvanced`: per agent, drives recompute+onDayAdvanced → `void goals.refresh(name,{force:true}).then(g=>agent.goal=g).catch().finally(()=>void ensurePlan(agent).catch())` (goal resolves before plan).
- `enrichObservation` (after relationships, before retrieval): `needs.recomputeFromState(agent); const need=needs.state(name); obs.self.needs=need; agent.needs=need; void goals.refresh(name).then(g=>{agent.goal=g; obs.self.goal=g}).catch(); if(goals.current(name)) obs.self.goal=goals.current(name)` — fire-and-forget refresh + synchronous cached-goal read (never blocks).
- Backstop: any throw → v1-shaped obs (outer try/catch). LLM action.goal still wins for its turn.

## 5. Contracts (additive only, `contracts/types.ts`)
```ts
export interface NeedState { energy:number; wealth:number; social:number; novelty:number; purpose:number; }
```
+ `Observation.self.needs?: NeedState`; + `AgentCardModel.needs?: NeedState`; update the `goal` doc comment (type `string|null` UNCHANGED). No other interface touched. NO server/Router/EmbedRequest change.

## 6. Prompt/mock
- `prompts.ts`: `buildGoalPrompt` (plain text); optional goal block in `buildDailyPlanPrompt`. (Keep `buildUserPrompt` v1-byte-identical — `needs` rides only inside the serialized obs JSON, not a new decision-prompt section.)
- `mock.ts`: `mockGoal`; `mockDailyPlan(persona,day,goal?)` re-weight; `normalizeObservation` defensive `self.needs` round-trip (parse 5 numerics, clamp, attach only when all present).

## 7. Inspector/HUD (additive)
- `Agent.ts` (FLAGGED, approved): add `needs: NeedState | null = null` (card-projection store, like relationshipRows/planStep).
- `Inspector.ts`: `InspectableAgent.needs?`; `if(agent.needs) card.needs=agent.needs`; add pure `formatNeedsRow(n)` → `"E▓▓░░ W▓░░░ S▓▓▓░ N▓░░░ P▓▓░░"` (reuse affinity-bar idiom).
- `UIScene.ts`: one additive needs text row on the card (create+update), empty when absent. (Goal already renders, now populated.) UIScene is owned here — disjoint from day/night (WorldScene).

## 8. Tests
- NEW `tests/agents/needs.test.ts`: recompute (energy/gold→drive), onOutcome refills, onDayAdvanced decay, dominant+tie-break, determinism (2 runs deep-equal), malformed input no-throw.
- NEW `tests/agents/goals.test.ts`: mock keyword per drive, determinism + cross-persona variety, cadence (cache hit no re-derive; force re-derives; threshold-cross re-derives), live good→cached / error→mockGoal fallback / throw→no-throw, inflight idempotency.
- NEW degrade test: live router always-errors → full cycle completes, agent.goal non-null, obs.self.needs present, no unhandled rejection.
- Fold into `cognition-runtime.test.ts`: after a cycle agent.goal non-null, obs.self.needs 5 numerics in [0,1], currentPlanStep still == steps[0].goal, no same-day goal thrash.
- Migrate `cognition-metrics.test.ts`: add `goalCalls` (init 0).
- CONFIRM green (no change): planner.test, mock-daily/mock-v2, mock-determinism, retrieval-determinism, reflection, memory, relationships, conversation*, party-emergence, prompts/prompts-v2 (buildUserPrompt byte-identical), inspector/inspector-v2.

## 9. File ownership (Wave 3a owns)
`src/agents/Needs.ts`(new), `src/agents/Goals.ts`(new), `src/agents/Cognition.ts`, `src/agents/Planner.ts`, `src/agents/Agent.ts` (one field), `src/llm/prompts.ts`, `src/llm/mock.ts`, `contracts/types.ts` (additive), `src/obs/Inspector.ts`, `src/scenes/UIScene.ts`, + tests. Does NOT touch `src/scenes/WorldScene.ts`, `src/world/**`, `src/config.ts` (day/night workstream), or `server/**` + `src/agents/memory/MemoryStore.ts` (resilience workstream). `AgentManager.ts` NOT edited (changes live inside Cognition.onDayAdvanced which it already calls).

## 10. Risks
1. Break 4-step plan → goal is prompt-INPUT only; coercePlanSteps untouched; night stays bed. Verify planner.test + mock-daily green.
2. Mock non-determinism → pure argmax + hash(persona:day), no RNG; determinism tests.
3. LLM blow-up under 429 → refresh gated to morning + threshold only, inflight-deduped, mock fallback, metered via goalCalls (~1 smart call/agent/day).
4. Goal thrash → cached {day,text,drivenBy}; enrich reads cache synchronously; threshold uses dominant-CHANGE not raw wiggle; no-thrash test.
5. Frozen-invariant breakage → zero edits to Reflection/MemoryStore/Relationships/Conversation/retrieval; only new additive subsystems + the try-wrapped needs.onOutcome in recordOutcome.
