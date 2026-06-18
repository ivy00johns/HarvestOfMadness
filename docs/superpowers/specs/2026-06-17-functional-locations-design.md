# Functional Locations — Wave 5b Implementation Spec

> Agents purposefully VISIT the varied buildings tied to role+goal (merchant→store, socialite→cafe, banker→office, wanderer→park), reading on screen like Smallville ("working at the office", "coffee at the cafe"). Additive + deterministic + dispersive. Suite 991 green → **991+ green + `tsc` clean**.

## Ground truth
- Landmarks cafe/office/park exist (5a); school emits NO landmark. `Planner.LANDMARK_KINDS` + `prompts.ts` plan prose already list all 8 kinds.
- CRITICAL: `src/llm/mock.ts` `normalizeObservation` landmark filter (~159-165) DROPS cafe/office/park (5a left inert). 5b MUST admit them.
- Decision ladder routes by plan-step KEYWORDS (`mock.ts` ~463-565 leisure branches: tavern/pond/market), NOT by `targetLandmark`. Activity label = `obs.self.currentPlanStep` = `step.goal` (WorldScene). `mockDailyPlan(persona, day, goal?)` has no role param; planner calls it. planner 4-step + night-at-bed FROZEN. `buildUserPrompt` byte-identity FROZEN (prompts.test).

## 1. NEW `src/agents/locations.ts` (pure; imports only @contracts/types — no cycle)
```ts
export type FunctionalKind = Extract<Landmark["kind"], "shop"|"cafe"|"office"|"park"|"tavern"|"school">;
export const ROLE_LOCATION: Record<DerivedRole, FunctionalKind|null> = {
  farmer: null /*default → byte-identical path*/, merchant: "shop", socialite: "cafe", wanderer: "park", banker: "office" };
// goal-keyword → kind (first-match; do NOT duplicate market/sell which mockDailyPlan already routes to shop):
//   cafe/coffee/catch up/colleague → cafe; office/work at/ledger/paperwork → office; study/school/lesson/teach → school; park/green/fresh air → park
export function goalLocation(goal): FunctionalKind|null
export function preferredLocation(role, goal): FunctionalKind|null  // goal wins over role; farmer+no-goal → null
export const FUNCTIONAL_STEP_TEXT: Record<FunctionalKind, {afternoon, evening}>  // Smallville-legible verb + routing keyword, afternoon texts <=40 chars where possible (40-char label clip)
```
tavern present for completeness but NEVER used by the role/goal v1 path (party-emergence). school entries dormant (no role maps there; reachable only via a "study" goal keyword no mock emits).

## 2. Routing (src/llm/mock.ts)
- **Filter (load-bearing):** widen the normalizeObservation landmark filter set to admit all 8 kinds (shop/bed/water/house/tavern/cafe/office/park). Frozen-safe: a landmark is inert unless a plan-step keyword targets it; mock-determinism base scene has none.
- **3 new decision branches** (cafe/office/park), mirroring the tavern branch shape EXACTLY (MOVE_TO when far; adjacent → cafe: TALK_TO an ALREADY-ADJACENT neighbor else EMOTE/WAIT; office/park: EMOTE/WAIT). Placement: SAME position as existing leisure branches — AFTER event ATTEND/INVITE + VOTE/proposal-spread, BEFORE the farm ladder (so a live party/event still wins). NONE target the tavern or move agents toward each other (kill-switch safe).
- **mockDailyPlan 4th optional param `role?`:** add a role-conditioning block AFTER the existing Wave-3 goal block, BEFORE steps assembly. Gate `if (role && role !== "farmer")`: `kind = preferredLocation(role, goal)`; if kind && kind!=="tavern", set afternoon/evening step.goal = FUNCTIONAL_STEP_TEXT[kind].{phase} + targetLandmark=kind, ONLY for phases the goal block left at default (goal keyword wins). Morning stays farm-ish, NIGHT stays bed (FROZEN). Byte-identical when role undefined/"farmer". Deterministic (preferredLocation is pure — no hash/RNG/Date.now). Import from "../agents/locations".

## 3. Planner + Cognition wiring
- `PlannerDeps.roleOf?: (name)=>string|null` (mirror goalOf). In `generate()` resolve `role = deps.roleOf?.(name) ?? undefined` and pass as 4th arg to BOTH mockDailyPlan calls. coercePlanSteps fallback stays 2-arg.
- Cognition planner construction: add `roleOf: (name) => this.roles.role(name) ?? this.agents.get(name)?.role ?? null` (cached, sync, deterministic; role derived in onDayAdvanced before plan pre-warm). Frozen-safe: harnesses without roleOf → undefined → byte-identical.

## 4. Live prompt (additive)
`buildDailyPlanPrompt` prose: add ONE sentence ("A merchant spends time at the store, a socialite over coffee at the cafe, a banker at the office, a wanderer at the park."). prompts-v2 asserts substrings present (safe). DO NOT touch `buildUserPrompt` (byte-identity); the plan-step text already flows via the existing CURRENT PLAN STEP gate.

## 5. School landmark — DEFER (do NOT add in 5b)
No role maps to school (vocabulary is farmer/merchant/socialite/wanderer/banker); adding a landmark needs the frozen Landmark.kind union + map.test count update. Keep school entries in locations.ts dormant for forward-compat. (Only add if explicitly approved later.)

## 6. Co-location social bonus — limited to the in-place cafe TALK_TO (§2). DEFER any cross-agent attraction (would create a NEW convergence point → kill-switch risk). The cafe TALK_TO fires only when a neighbor is ALREADY adjacent (no move-to-converge), like the existing socialite/tavern branches.

## 7. Tests — NEW `tests/agents/functional-locations.test.ts` (pure, $0)
- Mapping: ROLE_LOCATION total + farmer→null; preferredLocation role defaults + goal-beats-role; goalLocation keywords; determinism.
- mockDailyPlan: merchant→store/shop step, socialite→cafe, banker→office, wanderer→park (afternoon or evening, targetLandmark set); **FROZEN guard: mockDailyPlan(p,d) deep-equals (p,d,undefined,"farmer") deep-equals (p,d,undefined,undefined)**; all variants still 4 steps/phase-order/night-bed; tavern never via role across days 1..6.
- Decision routing (via mockRouter+buildUserPrompt): socialite cafe-step far→MOVE_TO cafe; adjacent+neighbor→TALK_TO; adjacent no-neighbor→EMOTE/WAIT; banker→office; wanderer→park; FILTER-ADMISSION proof (obs with only a cafe landmark + cafe step routes there — would've fallen through before 5b); NO-KEYWORD regression (farmer harvest-step + cafe landmark present → still HARVEST); determinism; graceful fallback (cafe step, no cafe landmark → farm ladder, no crash); priority (event ATTEND isNow beats cafe step).
- CONFIRM frozen (no edit): planner.test (4-step), mock-determinism, mock-daily, mock-v2, party-emergence (seeded convergence + kill-switch <3 at tavern — RUN FIRST), economy-invariants, prompts/prompts-v2 (buildUserPrompt byte-identity; buildDailyPlanPrompt substring), goals, roles, gossip, governance, map.test (school decision = no landmark; counts hold).

## 8. Ownership (Wave 5b owns)
src/agents/locations.ts (new), src/llm/mock.ts (filter + 3 branches + mockDailyPlan role param/block), src/agents/Planner.ts (roleOf dep + pass role), src/agents/Cognition.ts (1-line roleOf dep wiring — no logic change), src/llm/prompts.ts (1 sentence in buildDailyPlanPrompt; DO NOT touch buildUserPrompt), tests/agents/functional-locations.test.ts (new). Does NOT touch: contracts/types.ts, src/world/**, src/scenes/**, server/**, Roles/Goals/Conversation/EventBoard/Governance/memory. (school path deferred → no map.ts/contracts edit.)

## 9. Risks
1. Break party-emergence (NEW convergence) → each role → DIFFERENT building, cafe TALK_TO adjacent-only (no move-to-converge); with ROLE_MIN_SAMPLE=8 over ~2 game-days most agents stay farmer in that harness → barely fires; RUN party-emergence FIRST.
2. Break party-emergence (BLOCK seeded gather) → new branches placed AFTER ATTEND/INVITE/VOTE (event wins); priority test guards it.
3. Mock non-determinism → preferredLocation pure, no hash/RNG; frozen byte-identity guard + mock-determinism suite.
4. mockDailyPlan 2-arg byte-identity regression → role block strictly no-op when role undefined/"farmer"; mock-daily/mock-v2 tripwires.
5. Filter change leaks into frozen scenes/economy → grep confirms NO existing branch references cafe/office/park (only new ones do); no BUY/SELL added; mock-determinism + economy-invariants confirm; filter is mock-only (render reads world.landmarks()).
