# Contract — Phase C · Slice (Conversations #2): Conversation-summary memory

**Branch:** `feat/phase-c-conversation-summary` (stacked on the conversations
foundation branch).
**Goal:** After a conversation, each participant writes a one-line **summary of
what was discussed** (Smallville `summarize_conversation`) — a richer, more
meaningful memory than today's single quoted reply line. This **compounds**:
summaries become focal memories that future conversations ground on (via the
foundation slice's recall) and that reflection synthesizes. Deterministic in
mock, additive, and **gossip-inert** so the frozen gossip tests stay green.

## Why this shape (from the conversation understand-workflow map)

Today `_commit` (Conversation.ts:491) writes exactly ONE legacy memory pair at
**importance 5** (`I told X: "..."` / `X replied: "..."`) — a record of one
quoted line. A *summary* captures the whole exchange's gist. The gossip
first-hand candidate gate is `type==="observation" && origin===undefined &&
importance>=5` (Cognition.ts:885-891), so a summary written at **importance 4**
is **not** a gossip candidate — it cannot perturb `gossip.test.ts`.

## Files & changes (additive; the summary is a NEW per-conversation memory)

### 1. NEW pure `summarizeConversation(selfName, otherName, turns)` (Conversation.ts, exported)
- Deterministic one-liner from the POV of `selfName`, e.g.
  `Chatted with ${otherName} about ${gist}` where `gist` is a deterministic
  distillation of the substantive (non-opener) turns — reuse the existing
  `renderIdeas`-style extraction over the turn texts, or the longest non-opener
  turn, clipped. **Pure, no RNG/Date.** When there is no substance (no reply),
  return `""` (caller skips the write).
- Exported for unit tests.

### 2. `_commit` (Conversation.ts:491) — write 2 summary memories (one per participant)
- After the legacy pair, inside the same `if (reply)` guard (so a no-reply
  conversation writes neither), add:
  ```
  const sumA = summarizeConversation(aName, bName, turns);
  const sumB = summarizeConversation(bName, aName, turns);
  if (sumA) this.writeMemory(aName, sumA, SUMMARY_IMPORTANCE);
  if (sumB) this.writeMemory(bName, sumB, SUMMARY_IMPORTANCE);
  ```
  in a defensive try/catch.
- `export const SUMMARY_IMPORTANCE = 4` — **BELOW the gossip first-hand gate
  (Cognition.ts:891 `importance < 5`)**, so summaries are gossip-inert. Document
  the gate reference inline.
- **Per-conversation, NOT per-turn** — exactly 2 summaries per conversation
  (one per participant), mirroring the one-pair anti-spam discipline.
- The summary text MUST NOT start with the diffusion-dedup preambles
  (`"X told me about"` / `"X said:"` etc. — the foundation slice's `startsWith`
  filters); `Chatted with ...` is safe.

### 3. Tests to UPDATE (the write count legitimately changes 2 → 4 per conversation)
- `tests/agents/conversation-multiturn.test.ts`: the "exactly ONE legacy memory
  pair" assertion — keep proving exactly ONE legacy pair AND no per-turn spam, but
  account for the +2 per-conversation summaries (total 4 writes: the pair + 2
  summaries). Do NOT weaken the no-per-turn-spam invariant.
- `tests/agents/conversation-topics.test.ts`: the `writes.length===2` assertion →
  the new expected count (with summaries), keeping the "no per-turn memories" intent.
- `tests/agents/conversation.test.ts` + any test asserting exact post-conversation
  memory writes/counts: update to reflect summaries, preserving invariants.
- **`tests/agents/gossip.test.ts`: MUST stay green unchanged** — summaries at
  importance 4 are below the first-hand gate, so the gossip candidate set is
  unchanged. If any gossip test breaks, the summary importance/inertness is wrong —
  fix the implementation, do NOT weaken the gossip test.
- **Reflection-timing ripple (the key convergence risk):** summaries are
  `observation` memories, so they accumulate toward `maybeReflect` (threshold 30).
  Multi-day integration tests (`cognition-integration.test.ts`) may see reflections
  fire a little sooner. This is deterministic (replay-identical). Update only the
  legitimately-affected timing assertions; never weaken a determinism or
  reflection-correctness invariant. REPORT every test touched with justification.

### 4. NEW test `tests/agents/conversation-summary.test.ts`
- `summarizeConversation` pure/deterministic (same inputs → same string), mentions
  the other agent, references the gist, empty when no reply, zero RNG/Date.
- Integration (mock): after a conversation each participant has a summary memory at
  importance 4 mentioning the other + topic; the run is **replay-identical**.
- **Gossip-inert proof:** a conversation that writes summaries does NOT increase
  the gossip candidate/relay count (assert summaries never appear as gossip, e.g.
  by importance < 5 / no `gossip` bus event attributable to a summary).

## Determinism & invariants — MUST hold
- Zero `Math.random` / zero `Date`. Mock summary is a pure function of
  `(selfName, otherName, turns)`.
- `node_modules/vitest/vitest.mjs run` green (1223 on this stacked branch +
  new tests). `tsc --noEmit` clean.
- The legacy memory pair is **preserved** (drives the feed fields + frozen
  assertions). Affinity untouched (+2/side). Conversation event payload unchanged.
- Summaries are **per-conversation** (2 total), gossip-inert (importance 4), and
  fire-and-forget / never-throw (defensive try/catch in `_commit`).

## Out of scope (explicit — later slices)
- **Live-LLM conversation summarization** (an LLM `summarize_conversation` call) —
  deferred together with **conversation-call budget metering** (the map flagged
  conversation live calls bypass the ceiling); this slice's summary is the
  deterministic mock template in both modes (the summary is internal memory, not
  displayed dialogue, so live still shows real LLM reply bubbles).
- Sentiment-driven affinity; structured GossipBoard (subject/claim) + rumor
  distortion; making summaries gossip-worthy.
- North Star update + commit — orchestrator does these after the gate.
