# Governance v1 — Propose + Vote on a Town Rule — Implementation Spec (Wave 4c)

> The reference's "election": an agent proposes a shared town rule, it diffuses, agents vote, a deadline+majority tally adopts/rejects. LAST brain wave; heaviest contract churn (one new ActionType). Builds on roles (shipped, read DEFENSIVELY) + gossip + event-diffusion. Suite 933 green → **933+ green + `tsc` clean**.

## Mechanism decision (justified)
ONE new ActionType **`VOTE`** (target `{proposalId, support}`); **PROPOSE rides the existing `USE_OBJECT` on the notice_board** (no PROPOSE ActionType — minimizes the executor-matrix blast). VOTE: energy 0, always-legal-when-aware-and-unvoted (like EMOTE), NO adjacency (you vote on a town-wide proposal, not at a booth).

## Full VOTE ripple (every site — tsc Record-exhaustiveness auto-enumerates the rest)
1. `contracts/types.ts` ActionType union += `"VOTE"`.
2. `contracts/types.ts` `ENERGY_COSTS` (Record<ActionType,number>) += `VOTE: 0` (tsc FAILS without it — add in the same step; run tsc immediately to surface the blast).
3. `contracts/types.ts` `AgentAction.target` union += `{ proposalId: string; support: boolean }`.
4. `contracts/types.ts` `Observation.self` += optional `activeProposal?: { id; proposer; ruleText; day; awareCount; yes; no }` + `myVote?: boolean` (additive).
5. `contracts/types.ts` add shared `TownProposal` + `ProposalStatus` interfaces (near SimEvent); EventKind doc block += `proposal_opened`/`proposal_heard`/`proposal_resolved` (documented, open union).
6. `src/agents/ActionExecutor.ts` += `onVote?` in `ExecutorCognitionHooks`, `isVoteTarget` guard, `case "VOTE":` (target-shape precondition only; calls `cognition.onVote`; ok:true).
7. `src/agents/Observation.ts` — DO NOT add VOTE to `computeAvailableActions` (keeps it pure → observation.test green). Instead inject VOTE into `obs.availableActions` in `Cognition.enrichObservation` when an open, unvoted, known proposal exists.
8. `src/llm/mock.ts` `ACTION_TYPES` allowlist += `"VOTE"`; `normalizeObservation` passes through `self.activeProposal`/`self.myVote` (defensive).
9. `src/llm/mock.ts` `decide()` += a VOTE branch (deterministic; placed after event ATTEND/INVITE, before plan-follower; gated on `can("VOTE")` + active unvoted proposal).
10. `src/agents/Cognition.ts` `outcomeText` += `case "VOTE":`; `OK_IMPORTANCE_HINTS` += `VOTE: 4`.
11. `src/agents/AgentRuntime.ts` `describeAction` += `case "VOTE":`.
12. `src/llm/prompts.ts` `buildSystemPrompt` action enum += `VOTE` + a world-rule line + the `{proposalId,support}` target shape; `buildUserPrompt` += an ACTIVE PROPOSAL section (only when `obs.self.activeProposal` present — byte-identical when absent).

## Governance.ts (NEW, pure, in-memory, never throws — mirror EventBoard)
`TownProposal { id, proposer, ruleText, day, phase, closeDay, closePhase, status }`. ONE active proposal at a time.
- `open(proposal)` only if none `open`; proposer auto-aware + auto-yes. `current()`, `hasOpen()`.
- `markAware(id,name)→bool` / `isAware` / `awareCount` / `awareNames`.
- `vote(id,name,support)→bool` (first vote sticks, idempotent; auto-marks aware) / `hasVoted` / `myVote`.
- `resolveIfDue(now)` (lazy, no global tick): **early-adopt** when `yes > awareCount/2`; at **deadline** (closeDay/closePhase = openDay+1 evening) adopt iff `yes > votedCount/2 AND votedCount>=2` (min quorum 2 — no lone-proposer auto-adopt), else **reject**. Mutates status; returns `{adopted, tally}` on transition. GUARANTEES termination (dual: early-majority OR deadline) — no deadlock.
- `activeNorm()` (adopted rule text; the only v1 "effect" — observable, NO economy mutation). `tallySnapshot(id)→ProposalTally`.
- `static composeRule(role, dominantDrive, day)`: deterministic templated rule from role+drive+day (hash(role+day) variety, like mockGoal). **Rules are about farming/economy conduct, NEVER "gather at the tavern"** (preserves party kill-switch). Reads role DEFENSIVELY (works whether or not roles shipped; roles HAS shipped).

## Cognition wiring (additive, defensive, fire-and-forget)
- `readonly governance = new Governance();` (beside `events`).
- `onVote(agent, proposalId, support)`: record vote + write a memory ("I voted for/against the proposal: …", imp 4) + `maybeResolve()`. Satisfies `ExecutorCognitionHooks.onVote?`.
- `onUseObject` notice_board branch (AFTER existing event diffusion): `maybeOpenOrLearn(agent)` — if no open proposal AND a deterministic gate fires (`hash(name+day)%N===0`, rare/replayable): open one (composeRule from role + dominantDrive(needs), emit `proposal_opened`, imp-8 memory); else if an open proposal the agent doesn't know: markAware + imp-7 memory + `proposal_heard`.
- `onTalk` (AFTER event-diffusion + gossip, own try/catch): if speaker knows the open proposal and listener doesn't → markAware(listener) + imp-6 memory ("X told me about the proposed rule: …") + `proposal_heard`. Touches NO gossip/event sets.
- `enrichObservation` (after events block): surface `obs.self.activeProposal` + `obs.self.myVote` (additive); inject `"VOTE"` into `obs.availableActions` when aware+open+unvoted; then `maybeResolve()`.
- `onDayAdvanced`: `maybeResolve()` (deadline check).
- `maybeResolve()`: `const r = governance.resolveIfDue(now); if (r) { emit proposal_resolved {id,adopted,yes,no,awareCount}; on adopt write norm memory imp-7 to every aware agent; }` — all fire-and-forget, try-wrapped.

## Deterministic mock vote (mock.ts decide())
`support = hash(self.name + proposalId) % 2 === 0`, biased by affinity-to-proposer if present (read obs.self.relationships; affinity>=0 → lean yes). Pure (no RNG). VOTE only appears when enrichObservation injected it (governance present), so frozen mock-determinism scenes (no activeProposal) are byte-identical.

## HUD (additive, mirror PartyPanel)
- NEW `src/obs/GovernancePanel.ts` (pure): `buildGovernancePanel(tally, townSize, maxNames=6) → {ruleText, proposer, status, tallyLine "Yes N · No M · K/12 aware", yes, no, awareCount, voterNames}`.
- `src/obs/wiring.ts` SimControls += optional `governanceTally?(): ProposalTally | undefined` (via `manager.cognition()?.governance.tallySnapshot(...)`, Object.assign trick — AgentManager untouched).
- `src/scenes/UIScene.ts`: `renderGovernance()` + a small panel band (parallel to renderParty; hide while a trace panel is open; click-through union via the existing publishPanelRect pattern). Additive.

## Tests
- `tests/qe/executor-matrix.test.ts`: ADD a `describe("VOTE precondition")` (valid {proposalId,support} → ok:true + hook called; malformed target → ok:false readable reason; no-hooks → ok:true). Do NOT add VOTE to the "unknown action" test (DELETE_FARM stays the probe). EVERY existing row byte-identical.
- NEW `tests/agents/governance.test.ts` (mirror event-diffusion harness): Governance unit (open-once, proposer auto-yes, vote idempotent, markAware, composeRule deterministic); propose seam (USE_OBJECT opens when gate fires, emits proposal_opened, imp-8 memory); diffuse (onTalk knower→non-knower marks aware + memory + proposal_heard; non-knower→non-knower nothing; idempotent); deterministic vote; tally adopt (early majority → proposal_resolved adopted:true, activeNorm set); reject on no-quorum (lone proposer at deadline → rejected); reject on no-majority; Observation surfacing (activeProposal + VOTE injected when aware+unvoted; myVote after voting).
- NEW `tests/qe/governance-determinism.test.ts`: obs w/ activeProposal+VOTE → mockRouter byte-identical across 50 calls + days; support is pure fn of (name, proposalId).
- NEW `tests/agents/governance-lifecycle.test.ts` (mirror party-emergence harness: real World+TimeSystem+Cognition mock, runDecisionCycle, msPerTile:0): full lifecycle across sim-days — USE_OBJECT opens → diffuses via talk → ≥2 VOTE → tally adopts/rejects → proposal_resolved; awareCount grows; TERMINAL status reached (deadline guarantees no deadlock); deterministic.
- CONFIRM green (no edit): mock-determinism, executor-matrix (only additive describe), party-emergence (norms not tavern-convergent), gossip, event-diffusion, recurring-events, planner, goals, roles, mock-v2/daily/events, observation, inspector*, contract-conformance (server untouched), economy-invariants (no economy mutation).

## Ownership (Wave 4c owns)
src/agents/Governance.ts (new), src/agents/Cognition.ts, src/agents/ActionExecutor.ts, src/agents/Observation.ts (VOTE injection lives in Cognition, not computeAvailableActions), src/agents/AgentRuntime.ts, contracts/types.ts (ActionType/ENERGY_COSTS/target/Observation additive/EventKind doc/TownProposal), src/llm/prompts.ts, src/llm/mock.ts, src/obs/GovernancePanel.ts (new), src/obs/wiring.ts, src/scenes/UIScene.ts, tests (executor-matrix additive + 3 new governance tests), contracts/README.md (note). FLAG — do NOT touch: server/**, contracts/openapi.yaml, CompleteRequest/Response (governance is client-only — contract-conformance pins 3 paths, breaks if touched); src/agents/AgentManager.ts (reach governance via cognition() getter + wiring Object.assign); EventBoard/Conversation/Needs/Goals/Roles/Relationships/Planner (read-only deps); Agent.role (read obs.self.role defensively, don't re-freeze).

## Risks
1. ActionType ripple breaks executor-matrix → VOTE is the ONLY new type; enumerate all sites; tsc Record-exhaustiveness surfaces the blast; keep VOTE out of the unknown-action test; additive describe only.
2. ENERGY_COSTS exhaustiveness → add VOTE:0 with the union member, same step; tsc is the guard.
3. Mock non-determinism → support = hash(name+proposalId) (+affinity sign), no RNG; VOTE only when injected so frozen scenes byte-identical; determinism test.
4. Vote never reaches quorum (deadlock) → dual termination (early `yes>aware/2` OR deadline adopt-or-reject with quorum 2); resolveIfDue called from enrichObservation + onDayAdvanced (no global tick); reject-on-no-quorum + no-majority tests.
5. Break event-diffusion/party-emergence/gossip → onTalk governance block additive in own try/catch, touches no existing sets; norms farming-conduct not tavern; onUseObject appends after event diffusion.
