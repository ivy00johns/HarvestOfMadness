# Contract — Phase C · Slice 2 (Conversations #1): Memory/gossip-grounded conversation topics + legible feed

**Branch:** `feat/phase-c-conversations-gossip`
**Goal:** Conversations stop being generic small-talk and become **about what an
agent actually knows/remembers/heard about the other** — which also makes the
*existing-but-invisible* gossip substrate **audible** (a heard rumor is a
high-importance focal memory → becomes a conversation topic). This is
Smallville's `new_retrieve(focal=other) → summarize_ideas → utterance` step,
built on the **already-green** conversation+gossip+memory infrastructure. Plus:
the spectator can finally **read** conversations in the feed.

## Why this shape (from the understand-workflow map)

The pipe already exists and is green (1205 tests): multi-turn dialogue
(`ConversationSystem`), multi-hop gossip with origin/hop/dedup/decay/termination
(`Cognition` Wave-4b), event diffusion, relationship summaries, reflection,
transcript HUD, and the FreeLLMAPI proxy (`_liveReply` → `buildReplyPrompt` →
fast tier). **The gap is content, not plumbing.** The single highest-value /
medium-risk enrichment is **topic-from-memory** (per the fidelity ranking); it is
foundational — summary/sentiment/distortion slices stack on it.

Today `buildReplyPrompt` (prompts.ts:260) receives only
`selfPersona/selfName/otherName/affinitySummary/transcriptTail` — **no memories,
no topic**. `mockReply` (Conversation.ts:60) is persona-keyword templated with no
grounding. So replies are generic.

## Files & changes (all STRICTLY ADDITIVE — absent inputs ⇒ byte-identical)

### 1. `src/agents/Conversation.ts` — add an optional memory seam
- Extend `ConversationOpts` with an **optional** async recall dep:
  `recall?: (agentName: string, query: string) => Promise<MemoryEntry[]>`
  (default `undefined`). When undefined, behavior is **byte-identical to today**
  (every existing conversation test omits it).
- In `_oneTurn` (Conversation.ts:252), before generating a reply, when `recall`
  is present: `const ideas = await this._recallIdeas(responder, other)` — a new
  private helper that calls `recall(responder.name, other.name)` (focal-on-other,
  Smallville's `new_retrieve(focal)`), takes the top ~2-3 entries, and renders a
  short deterministic **ideas** string (gist of what `responder` knows/heard
  about `other`). Wrap in try/catch → on throw or empty, `ideas = ""` (additive).
- Thread `ideas` into BOTH branches of `_oneTurn`:
  - **live:** `_liveReply(..., ideas)` → `buildReplyPrompt({... , ideas})` (gated, see §3).
  - **mock:** when `ideas` non-empty, use a NEW pure `mockTopicalReply(responderPersona,
    otherName, ideas, turnIndex)`; when empty, use the existing `mockReply`
    (byte-identical). `mockTopicalReply` weaves the topic into a short
    persona-flavored line — **pure, no RNG/Date**, variant indexed by
    `turnIndex % len`, deterministic from `(persona, ideas, turnIndex)`.
- **Determinism caution:** `recall`→`retrieve` bumps `lastAccess`. It is
  deterministic (same run order ⇒ same bumps), but verify no retrieval/integration
  test regresses; the new calls only happen when `recall` is wired (real sim +
  the new test), not in the frozen unit tests.

### 2. `src/agents/Cognition.ts` — wire the recall dep
- At `ConversationSystem` construction (~Cognition.ts:335-349), pass
  `recall: (name, query) => this.memory.retrieve(name, query, K)` (reuse the
  deterministic store proven by `retrieval-determinism.test.ts`; pick a small K
  e.g. 3). Defensive: the store retrieve already never throws into callers; keep
  the ConversationSystem-side try/catch regardless.

### 3. `src/llm/prompts.ts` — `buildReplyPrompt` gains optional `ideas` (GATED)
- Add `ideas?: string` to the opts. When present + non-empty, insert ONE user-block
  section, e.g.: `\n\nWhat's on your mind about ${otherName} (draw on it if it
  fits): ${ideas}`. When absent/empty → **byte-identical** output (the prompts.ts
  gating convention at 106/137/173). This benefits the live path; mock uses
  `mockTopicalReply` instead.

### 4. `src/obs/Feed.ts` — make conversations legible
- Add a `formatFeedItem` case for `kind:"conversation"` (today it falls through to
  the legacy two-liner via `formatEventLine`, Feed.ts:364). Render a readable line
  from `payload.turns[]` (e.g. `A ⇄ B: "<turn0>" · "<turn1>"`, clipped). Pure,
  deterministic, no new event shape. Mirror the existing `agent_speech` case (~287).

### 5. NEW pure export `mockTopicalReply` (in Conversation.ts, exported for tests)
- `mockTopicalReply(bPersona: string, aName: string, ideas: string, turnIndex = 0): string`
  — deterministic, persona-keyworded, weaves a short reference to `ideas`. No
  RNG/Date. Returns a `mockReply`-style sentence when `ideas` is empty (so callers
  can always use it, but `_oneTurn` only invokes it when ideas non-empty).

## Determinism & invariants — MUST hold (tests are the source of truth)

- **Zero `Math.random` / zero `Date`** in any new logic. Mock topical replies +
  ideas rendering are pure functions of `(persona, retrieved-memory-text,
  turnIndex, otherName)`. `retrieve` in mock is deterministic (no embeddings ⇒
  recency+importance only).
- **`node_modules/vitest/vitest.mjs run` stays green** (currently 1205 on this
  branch). Specifically preserve:
  - `conversation.test.ts` / `conversation-multiturn.test.ts`: **exactly ONE
    legacy memory pair** per conversation (do NOT write new memories this slice),
    **+2/side affinity only** (do NOT touch affinity), `turns[]` length 2..4,
    strict A/B alternation, `mockReply` turnIndex-0 **byte-identical to v2**, mock
    replay identical, live-error→mock no-throw, earshot guard. The new behavior is
    additive: with no `recall` dep wired (as these tests construct it) the output
    is byte-identical.
  - `gossip.test.ts`: gossip dedup/decay/termination + `gossipCore` byte-stability
    untouched (we only READ memories for topics; we do NOT add gossip memories or
    change relay text).
  - `mock-determinism.test.ts`: `mockRouter`/`decide()` untouched — **the opener
    `say` stays generic this slice** (no change to mock.ts decide TALK_TO).
  - `retrieval-determinism.test.ts`: scoring untouched; only new call-sites.
  - `transcript.test.ts`: payload.turns[] shape unchanged.
- `node_modules/typescript/bin/tsc --noEmit` clean.
- Fire-and-forget / never-throw (rules 1 & 10): all recall + rendering wrapped;
  a recall failure silently degrades to the existing generic reply.

## NEW tests — `tests/agents/conversation-topics.test.ts`
- **mock topical reply purity:** `mockTopicalReply` is deterministic (same inputs →
  same string, repeated); references the supplied `ideas`; empty `ideas` →
  equals `mockReply` (byte-identical); zero RNG/Date.
- **focal grounding (integration, mock mode):** wire a `recall` that returns a
  seeded focal memory (e.g. a relayed RUMOR about `other`, importance ≥ 5); run a
  conversation; assert a reply turn references that rumor's gist (proving heard
  gossip becomes an audible topic) AND the run is **replay-identical**.
- **additive default:** with NO `recall` dep, the conversation `turns[]` are
  byte-identical to the pre-slice output (guard against regressions).
- **`buildReplyPrompt` gating:** absent/empty `ideas` ⇒ byte-identical `{system,
  user}`; present `ideas` ⇒ the section appears exactly once.
- **feed legibility:** `formatFeedItem` on a `kind:"conversation"` event renders a
  readable multi-turn line (not the legacy two-liner).

## Out of scope (explicit — the path to "full" Smallville, later slices)
- **Conversation-summary memory** (Smallville `summarize_conversation`) — next slice.
- **Sentiment-driven affinity** (replace flat +2) — high-risk; touches frozen
  `+2/side` assertions; later.
- **Structured GossipBoard (subject/claim) + rumor distortion** — high-risk;
  collides with gossip determinism; later.
- **Topical openers** (mock.ts `decide()` TALK_TO `say`) — left generic this slice
  to keep `mock-determinism` byte-identical.
- **Conversation tier fast→smart**, conversation LLM budget metering — noted levers.
- North Star doc update + commit — orchestrator does these after the gate.
