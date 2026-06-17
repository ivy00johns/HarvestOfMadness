# Smallville Completion — A Self-Organizing Party (the emergence proof)

- **Date:** 2026-06-17
- **Status:** Approved-by-standing-goal (autonomous overnight build; user asleep, no blocking, NO COMMITS)
- **Goal:** Import everything we still need from Smallville and PROVE it: seed one host's intent, watch the invitation diffuse agent-to-agent, and watch agents converge at the tavern. Then expand toward Project Sid (next phase).

## Why this, and what already exists

The cognition core IS Smallville already (`src/agents/Cognition.ts` + memory/Reflection/Planner/Relationships): memory stream, retrieval (recency 0.995 · importance 1–10 · relevance cosine), threshold reflection, recursive daily planning, asymmetric relationships, gifts, and earshot→memory (`recordSpeech`). The research confirms these four — dialogue+memory, retrieval, reflection, planning — are exactly what produce the Valentine's-party self-organization. So we do NOT port `persona/`. The gap is the **emergent social layer**:

1. **News-carrying conversations** — today `TALK_TO` drops a single line into earshot memory; it doesn't reliably transfer a *fact* an agent should act on.
2. **Information diffusion** — knowers must re-share, so news cascades multi-hop (research: 12 agents heard about Isabella's party).
3. **Event self-organization** — a seeded host intent → invitations spread → knowers re-plan to attend → they gather at the location at the right time.

## Design (mechanism that works in BOTH mock and live)

### Event model
A `SimEvent` = `{ id, host, location: Vec2 (tavern door), day, phase, description }`. One is seeded at sim start: **Social Sage hosts a gathering at the tavern, day 1 evening.** Stored in a small `EventBoard` owned by `CognitionSystem` (or AgentManager). The host "knows" it from the start.

### Knowledge + diffusion
- Each agent has an event-knowledge set (who knows which event). The host starts knowing the seeded event.
- **Diffusion via conversation:** when a knower performs `TALK_TO` on an adjacent agent (the existing `onTalk` hook), the listener LEARNS the event — gains a high-importance (`7`) `observation` memory "(`Sage` told me about the gathering at the tavern this evening)" and is added to the knowledge set. This is faithful ("they talked, the host mentioned it") and deterministic for the mock proof. In live mode the LLM also voices it and `recordSpeech` reinforces it.
- This makes knowledge spread one hop per conversation; multi-hop cascades as new knowers converse.

### Behavior (so it self-organizes in mock too, not just live)
Add to the **mock heuristic** (`src/llm/mock.ts`), as high-priority branches evaluated before routine farm work, using new `Observation.self.knownEvents`:
- **Attend:** if a known event is happening **this phase** and I'm not adjacent to its location → `MOVE_TO` the event location (the tavern); if already adjacent, stay (WAIT/EMOTE happy).
- **Spread:** else, if I know an event that is still upcoming AND a visible adjacent agent does NOT know it → `TALK_TO` them with an invite line (drives diffusion). (Generalizes the current "social persona chats" branch to "any knower spreads news".)
Live mode: `enrichObservation` puts `knownEvents` on the observation and the planner/prompt invites the LLM to attend; the same `onTalk` diffusion applies.

### Observation surface
`Observation.self.knownEvents?: { host, location, day, phase, description, isNow }[]` — populated by `CognitionSystem.enrichObservation` from the agent's event-knowledge. `isNow = (event.day===today && event.phase===currentPhase)`.

### Seeding
At `AgentManager.start()` (or cognition bootstrap), register the seeded event and mark the host as knowing it + give the host a goal/plan-step "invite everyone to my gathering at the tavern". Pick day 1 evening so it fires within the first sim-day.

## The proof (the gate)
A headless vitest sim (`tests/agents/party-emergence.test.ts`), MOCK mode, deterministic:
1. Seed the event (Sage, tavern, day1 evening).
2. Run the manager/world forward enough cycles to reach the event phase.
3. Assert **diffusion**: the number of agents who know the event ≥ a threshold (e.g. ≥ 4 of 6) before/at event time.
4. Assert **convergence**: ≥ 3 agents are at/adjacent to the tavern during the event phase.
5. Kill-switch sanity: with the event NOT seeded, no convergence at the tavern occurs (the gathering is caused by the seed+diffusion, not by chance).

Also surface it visibly: emit `WorldEvent`s to the feed — "Sage invited Gus to the gathering", "Gus arrived at the gathering" — so the live game narrates the party for the user in the morning.

## Affected areas
- `contracts/types.ts` — `SimEvent` type; `Observation.self.knownEvents?`.
- `src/agents/Cognition.ts` (+ a small `EventBoard`) — registry, knowledge set, diffusion in `onTalk`, `knownEvents` enrichment, feed events.
- `src/agents/AgentManager.ts` — seed the event at start; host's initial knowledge.
- `src/llm/mock.ts` — attend + spread branches using `knownEvents`.
- `src/agents/Planner.ts` / `src/llm/prompts.ts` — surface known events to the LLM (attend in the plan).
- `tests/agents/party-emergence.test.ts` — the proof; plus unit tests for diffusion + attend branches.

## Out of scope tonight (the "next phase" after the proof)
Project Sid / PIANO: explicit Social-Awareness module, goal-generation from needs, survival/economy pressure → role specialization, parallel cognition, more agents. Begin only once the party proof is green.

## Constraints (overnight)
- **No git commits** (TouchID). Work stays in the working tree; tests are the proof of correctness.
- Mock proof must be deterministic and $0. Live FreeLLMAPI server kept running for the visual.
