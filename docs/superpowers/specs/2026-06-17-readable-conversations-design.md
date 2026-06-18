# Readable Multi-Turn Conversations + Activity Labels — Implementation Spec

> Wave 2 (solo). Match the canonical Smallville reference: readable named multi-turn dialogue + a HUD transcript panel + per-agent activity labels. Relaxes the "single-utterance" invariant but stays ADDITIVE so all existing tests stay green. Suite is 795 green; bar after ≈ **815 green + `tsc` clean**.

## Ground-truth corrections (verified)
- `SPEECH_MAX_CHARS=160` already (not 60); `showSpeech` already word-wraps at width 230. Bubbles are largely readable — only a minor wrap bump (230→260) needed.
- A persistent activity EMOJI already exists (`AgentSprite.activityLabel`/`setActivityEmoji`). The readable activity label is an ADDITIVE second text object, not a rewrite.
- `mockReply`/`buildReplyPrompt` currently live in `Conversation.ts`. `chebyshev` is exported from `src/obs/Observation.ts`.

## 1. Multi-turn engine (`src/agents/Conversation.ts`)
- `MAX_TURNS = 4` total utterances INCLUDING A's opener (so ≤3 generated replies; each side ≤2). `TURN_GAP_MS=1500`, `REPLY_BUBBLE_DELAY_MS=1300` (existing). `CLOSER_RE=/\b(bye|goodbye|see you|farewell|good night|take care|later)\b/i`.
- `handleReply(speaker, listener, say)` signature UNCHANGED (frozen wiring). Guard: `chebyshev(speaker.pos, listener.pos) <= 1` at start (earshot, checked once); bail if not adjacent. A opens (turn 0 = the passed `say`); strict alternation B,A,B…
- Each turn: live → fast-tier via `buildReplyPrompt` with the transcript tail; mock fallback on error/empty/throw; sanitize (strip quotes, slice ~120). Stop on `MAX_TURNS` or `CLOSER_RE` match or empty. ENTIRE exchange fire-and-forget (rule 10 no-block).
- **Affinity: engine touches it ZERO times.** `onTalk` already does `recordInteraction` ×2 (+2/side) before the engine. Multi-turn must NOT multiply affinity.
- **Memory: ONE legacy reply pair per conversation, written in `_commit` (NOT per turn):** B side `I told ${A}: "${turns[1].text}"` (importance 5); A side `${B} replied: "${turns[1].text}"` (importance 5). NO per-turn memories (anti-spam; keeps gossip/diffusion dedup counts green). Full transcript lives in the bus payload, not memory.
- **Bubbles:** A's opener already shown by AgentRuntime; engine schedules turns ≥1 sequentially via `setTimeout(() => getRenderApi()?.showSpeech(turn.speaker, turn.text), REPLY_BUBBLE_DELAY_MS + (k-1)*TURN_GAP_MS)`, each in try/catch.
- **Feed event `kind:"conversation"` — backward compatible:** keep existing `text` (`A: "…" — B: "…"`) + `payload.{speaker,listener,say,reply}`; ADD `payload.turns: ConversationTurn[]` + `payload.conversationId = "${A}|${B}|${day}|${phase}"`.
- `mockReply(bPersona, otherName, prev, turnIndex=0)`: each persona branch returns a 2–3 line variant array indexed by `turnIndex % n`. **turnIndex 0 MUST be byte-identical to today's output** (keeps the 10 existing mockReply assertions green). Pure index, no RNG/time → deterministic. Give one social variant a closer line (hits CLOSER_RE → natural end).
- `Cognition.onTalk` wiring is UNCHANGED — read-only confirm it already calls `handleReply`.

## 2. Contracts (`contracts/types.ts`, ADDITIVE)
```ts
export interface ConversationTurn { speaker: string; text: string; }
export interface Conversation { id: string; participants: [string, string]; turns: ConversationTurn[]; day: number; phase: Phase; }
```
+ a doc comment for the open-union `"conversation"` payload. `AgentCardModel.planStep?` already exists (activity source) — no card field.

## 3. Prompts (`src/llm/prompts.ts`)
- Move/add exported `buildReplyPrompt({selfPersona, selfName, otherName, affinitySummary, transcriptTail})` (multi-turn: "Continue with ONE short in-character sentence (≤15 words); wrap up naturally if it fits"). `Conversation.ts` imports it. No test imports `buildReplyPrompt` from Conversation, so the move breaks nothing.
- **`src/llm/mock.ts`: NO CHANGE** (mockReply stays in Conversation.ts).

## 4. Rendering
- **Bubble (`WorldScene.showSpeech`):** bump `wordWrap.width` 230→260. No config change.
- **Activity label (`WorldScene`):** add `AgentSprite.activityText` (second Text, below the name): `${FONT_SIZE_SMALL}px` (12, rule 14), color `#cdd6e4`, stroke #000 ×3, wordWrap `TILE_SIZE*5`, origin (0.5,0), depth `DEPTH_PROP`, added to the container. Track under the de-collided name in `restackLabels()` (`activityText.setY(label.y + LABEL_FONT_SIZE + 2)`). Add duck-typed `setActivityLabel(name, text|null)` (like `setActivityEmoji`) that truncates ~40 chars; `""` renders nothing.
- **Driver — `src/agents/AgentRuntime.ts` (APPROVED one line):** next to the existing `setActivityEmoji` duck-type, add `(renderApi as {setActivityLabel?:(n:string,t:string|null)=>void})?.setActivityLabel?.(agent.name, agent.planStep);`. `agent.planStep` is set by `enrichObservation` before each decision.
- **HUD transcript panel:**
  - NEW pure model `src/obs/Transcript.ts`: `conversationFromEvent(e: WorldEvent): Conversation | null` (reads `payload.turns`, falls back to `say`/`reply` 2-liner; null for non-conversation/malformed); `buildTranscript(conv, maxLines=6, maxChars=60): TranscriptView {participants, lines[], empty}`. Defensive, never throws.
  - `layout.ts` ADDITIVE: `transcript{X,Y,W,H,Rect}` docked in the left band BELOW the party strip, above the feed: `transcriptX=panelX; transcriptY=partyY+partyH+4; transcriptW=panelW; transcriptH=min(120,max(60, logY-transcriptY-4))`. Add pure `unionRect(a,b)` helper. Change NO existing constant value (layout.test stays green).
  - `UIScene`: `buildTranscriptChrome()` (in create()+relayout()) = bg + bold "Conversation" title + `maxLines` 12px rows (wordWrap), start hidden, refs nulled in relayout teardown. `onBusEvent`: on `kind==="conversation"` set `latestConversation = conversationFromEvent(e)`. `renderTranscript()` (from refreshAll, after renderParty): hide if empty OR `selectedAgent` (trace panel overlays); else render `[${speaker}]: ${text}` per line, alternating speaker colors. **Click-through:** extend `publishPanelRect()` to publish a `unionRect(partyRect, transcriptRect)` when `partyVisible || transcriptVisible` (else the existing panelRect/party logic). WorldScene's REG_HUD guard then covers it (no WorldScene click change).

## 5. Test migration (enumerate; mostly CONFIRM-PASS due to additive design)
- `tests/agents/conversation.test.ts`: all 10 mockReply unit assertions PASS (turnIndex 0 byte-identical); the "I told Alice:" / "Bob replied:" memory + conversation-event + "—" assertions PASS (legacy fields kept). ADD: `payload.turns` is array, length 2..4.
- `tests/agents/gossip.test.ts`, `event-diffusion.test.ts`, `party-emergence.test.ts`, `gift-emote.test.ts`, `tests/llm/mock-*.test.ts`, `tests/obs/feed.test.ts`: CONFIRM PASS (no per-turn memories, affinity unchanged, feed default formatter unchanged). Run them to confirm.
- NEW `tests/agents/conversation-multiturn.test.ts`: cap ≤4 & ≥2; alternation A,B,A; closer ends early; **affinity stays exactly +2/side after a 4-turn convo (not runaway)**; memory `startsWith("I told Alice:")` length exactly 1; mock determinism (run twice, identical turns); graceful fallback (router returns `{error}` → mock-filled turns, no throw); earshot guard (Chebyshev 2 → no conversation event).
- NEW `tests/obs/transcript.test.ts`: conversationFromEvent parse/null/malformed; buildTranscript caps/clips/empty.
- `tests/obs/layout.test.ts`: ADD transcriptRect below party, above feed, x==panelX, integer px; unionRect covers both. Change no existing assertion.
- `tests/llm/prompts*.test.ts`: ADD buildReplyPrompt assertions (≤15 words, transcript tail, plain text).
- WorldScene activity label: NO Phaser-instantiating vitest; visual-only (Playwright check at verify).

## 6. File ownership
OWNS: `src/agents/Conversation.ts`, `src/agents/Cognition.ts` (read-only confirm), `src/llm/prompts.ts`, `contracts/types.ts` (additive), `src/obs/Transcript.ts` (new), `src/obs/layout.ts`, `src/scenes/UIScene.ts`, `src/scenes/WorldScene.ts`, the ONE approved line in `src/agents/AgentRuntime.ts`, + all their tests. `src/llm/mock.ts`: NO CHANGE. Imports `chebyshev` from `src/obs/Observation.ts` (no edit).

## 7. Risk register
1. Memory spam → ONE reply pair per conversation, transcript in payload not memory (verified vs gossip counts).
2. Affinity runaway → engine adds zero affinity; onTalk's single +2/side stands; test asserts ==2.
3. LLM blow-up under 429 → MAX_TURNS=4 cap, per-turn mock fallback, fire-and-forget, closer ends early; cog-cost HUD surfaces spend.
4. Mock determinism → variants by pure `turnIndex % n`, turnIndex 0 byte-identical; determinism test diffs two runs.
5. HUD layout regression → transcript docked below party / above feed, clamped; trace panel overlays both; publishPanelRect union rect; pure layout tests assert non-overlap.
