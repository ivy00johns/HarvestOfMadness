# Contract — Phase C · Slice C1: Sentiment-driven affinity (warmth-only)

**Branch:** `feat/phase-c-sentiment-affinity`
**Goal:** Make a conversation's *tone* move the relationship, instead of every
talk being a flat `+2`. **User-chosen policy: WARMTH-ONLY (safest).** A neutral
or cold/curt chat still yields exactly today's `+2`; a genuinely warm chat earns
a **bonus on top** (up to `+8` total). Negative tone is **ignored** — there is
**no negative lexicon**, a hostile chat reads the same as a neutral one (`+2`).

**Deterministic, zero extra LLM calls, sim-faithful.** Sentiment is scored by a
**static valence lexicon** over the actual conversation transcript — NOT an LLM
call (live-LLM scoring + call metering stays deferred to a later slice, C3).

## Why this shape (from the affinity-system survey)

The flat `+2` is `AFFINITY_DELTAS.TALK_TO`, applied **synchronously** in
`Cognition.onTalk` (`src/agents/Cognition.ts:848-849`), **both directions**,
**before** the multi-turn conversation runs. The conversation itself is
fire-and-forget and its full transcript (`turns[]`) only exists at completion,
in `ConversationSystem._commit` (`src/agents/Conversation.ts:560`), which already
does the cross-cutting post-conversation writes (legacy memory pair + summary).

So the design is **strictly additive**, mirroring the proven C-phase pattern
("absent recall ⇒ byte-identical"):

- **Keep the synchronous `+2` EXACTLY as-is** (the neutral floor). Every test
  that asserts the *synchronous* path stays green untouched.
- **At conversation completion (`_commit`), score the transcript's warmth and
  apply a positive-only BONUS** to both directions — **only when the bonus > 0.**
  No warm words ⇒ no second mutation ⇒ byte-identical to today.

This means **near-zero frozen-test churn**: the at-risk
`conversation-multiturn.test.ts:160-161` (the "+2 after 4 turns" assertion) uses
a **grumbling/quiet** transcript with no warm words → bonus 0 → **still +2,
unchanged**. The genuinely-new behavior (a warm chat earns > +2) lands in NEW
tests. `conversation.test.ts:393-394` asserts `> 0`, which warmth-only only
strengthens.

## Files & changes

### 1. NEW pure module `src/agents/sentiment.ts` (no Phaser, no LLM, no I/O)
```ts
import type { ConversationTurn } from "@contracts/types";

/** Max warmth bonus added on top of the neutral TALK_TO floor (+2). 2 + 6 = +8
 *  total for a glowing exchange, matching the user-approved scale. */
export const WARMTH_BONUS_CAP = 6;

/** Curated POSITIVE-valence lexicon (lowercased, matched as whole word tokens).
 *  Warm-specific on purpose: the existing neutral/curt mock variants
 *  ("Hmph.", "Fine.", "If you say so.") must score ZERO, while genuinely warm
 *  copy ("good", "glad", "wonderful", "friend", …) scores. NO negative words —
 *  warmth-only policy. */
export const WARMTH_LEXICON: ReadonlySet<string> = new Set([
  // seed list — finalize during TDD so neutral mock variants stay at 0 and
  // warm/social variants score; keep it tight to avoid false hits:
  "good", "great", "wonderful", "lovely", "delight", "delightful", "glad",
  "happy", "joy", "joyful", "love", "dear", "friend", "friends", "kind",
  "kindly", "care", "thanks", "thank", "welcome", "wonderous", "wondrous",
  "appreciate", "grateful", "cheer", "cheerful", "warm", "hope", "smile",
  "enjoy", "pleasure", "pleased", "blessing", "sweet", "soon",
]);

/** Sum of positive-token occurrences across the WHOLE transcript, clamped to
 *  [0, WARMTH_BONUS_CAP]. Pure + deterministic: lowercase, split on
 *  non-letters, count tokens that are in WARMTH_LEXICON. No RNG, no Date. */
export function warmthBonus(turns: ConversationTurn[]): number { … }
```
- Tokenize each `turn.text`: `text.toLowerCase().split(/[^a-z]+/).filter(Boolean)`.
- `bonus = Math.min(WARMTH_BONUS_CAP, count)` where `count` = number of tokens in
  `WARMTH_LEXICON` across all turns. (Occurrence-count is acceptable; distinct-token
  count is an acceptable alternative — pick ONE and pin it with a test. Transcripts
  are ≤4 short utterances, so either is naturally bounded.)
- **The lexicon is NOT pinned word-for-word by tests** — only the observable
  properties are (neutral=0, a known-warm transcript>0, cap clamp, determinism).
  Tune the word list during TDD so the neutral mock variants stay at 0.

### 2. `src/agents/Relationships.ts` — new `recordWarmth` method
Add a focused method that applies a **raw positive delta** (the warmth bonus)
WITHOUT touching the `AFFINITY_DELTAS` constants (so gift/talk deltas and their
frozen tests are untouched) and WITHOUT incrementing interaction/talk/gift
counters (the talk was already counted by the synchronous `recordInteraction`):
```ts
/** Apply a conversation-warmth bonus to an existing/!new pair. Adjusts affinity
 *  only (clamped); does NOT bump talks/interactions/gift counters. Emits the
 *  same "relationship_updated" event shape so the feed + inspector update. */
recordWarmth(agentName: string, otherName: string, bonus: number, eventText: string): void {
  if (agentName === otherName) return;
  if (!Number.isFinite(bonus) || bonus <= 0) return;   // warmth-only: never lowers
  // create row if missing (same shape as recordInteraction), then:
  //   row.affinity = clampAffinity(row.affinity + bonus);
  //   row.updatedDay = today;
  //   emit "relationship_updated" { otherName, affinity: row.affinity, delta: bonus }
  //   this.deps.onChange?.(agentName);
}
```
- Guard `bonus <= 0` so this is genuinely **warmth-only** and never lowers
  affinity (defense-in-depth even though callers only pass > 0).
- Add `recordWarmth` to the `RelationshipStore` interface in `contracts/types.ts`
  (next to `recordInteraction`) so the type is honored at the wiring site.
- Do NOT re-run `refreshSummaryLazily` differently — same-day it no-ops anyway;
  match `recordInteraction`'s behavior or skip it (a warmth tweak need not change
  the one-liner). Keep `talks`/`interactions`/gift counters **untouched**.

### 3. `src/agents/Conversation.ts` — score + apply warmth at completion
- Add an OPTIONAL opt to `ConversationOpts` (frozen `handleReply` signature is
  UNCHANGED — this is a constructor dep, like `affinityText`/`writeMemory`):
  ```ts
  /** Apply a conversation-warmth affinity bonus (a→b). Optional: when absent
   *  (frozen tests that omit it), warmth is simply not applied — additive. */
  applyWarmth?: (agentName: string, otherName: string, bonus: number) => void;
  ```
- In `_commit`, after the memory/summary writes, compute the bonus from `turns`
  and apply it **both directions, only when > 0**, defensively (never throw):
  ```ts
  try {
    const bonus = warmthBonus(turns);
    if (bonus > 0) {
      this.applyWarmth?.(aName, bName, bonus);
      this.applyWarmth?.(bName, aName, bonus);
    }
  } catch {/* warmth must never break the commit */}
  ```
  (Symmetric: a warm exchange warms both people's view of each other — matches
  the current symmetric `+2`. Per-speaker asymmetry is explicitly OUT of scope.)

### 4. `src/agents/Cognition.ts` — wire `applyWarmth`
At the `new ConversationSystem({...})` site (`Cognition.ts:344`), add:
```ts
applyWarmth: (a, b, bonus) =>
  this.relationships.recordWarmth(a, b, bonus, "a warm conversation"),
```

### 5. NEW test `tests/agents/sentiment.test.ts` (pure-module teeth)
- Neutral/curt transcripts → bonus `0` (use the actual neutral mock variants:
  "Hmph. If you say so.", "Fine. Anything else?").
- A known-warm transcript → bonus `> 0`, scaling with warm-word count.
- Cap: a transcript stuffed with warm words clamps at `WARMTH_BONUS_CAP`.
- Empty transcript / empty turns → `0` (no throw).
- Determinism: same input → same output; **source-grep the module for zero
  `Math.random` / zero `Date`.**

### 6. NEW integration test `tests/agents/sentiment-affinity.test.ts` (the payoff)
Through the real `Cognition.onTalk` + `await SETTLE()` (same harness as
`conversation-multiturn.test.ts`):
- **Warm conversation → > +2 both sides.** A social/warm B (whose mock replies
  contain warm words) yields `affinity > 2` for BOTH directions, and equal on
  both sides (symmetric). Pin the EXACT computed value (e.g. `+2 + bonus`).
- **Neutral conversation → exactly +2 both sides** (byte-identical to today) —
  re-prove the additive guarantee through the live wiring (grumbling B).
- **A second `relationship_updated` event fires with `delta === bonus`** for the
  warm case, and its `affinity` is in `[-100, 100]` (keeps `v2-full-loop`
  invariant). NO warmth event fires for the neutral case.
- **Determinism:** two identical warm runs → identical final affinity + identical
  event sequence.

## Frozen-assertion audit — MUST verify each before/after (mutation-teeth)
The implement agent MUST run the FULL suite and, for EACH of these, confirm it
either stays green untouched or is updated to a **hand-verified computed** value
(reason about the transcript's warm-word count), then prove the new assertion has
teeth (inject a wrong value → RED → restore):

- `conversation-multiturn.test.ts:160-161` — grumbling/quiet transcript, expect
  **still `+2`** (no warm words). If it changes, the lexicon is too loose — tighten
  it so curt variants score 0, rather than editing this assertion.
- `conversation.test.ts:393-394` (`> 0`) — stays green (warmth only adds).
- `relationships.test.ts` (71/75/83/91/94/95/108/109/186) — synchronous path +
  gifts → **untouched**.
- `gift-adversarial.test.ts`, `cognition-runtime.test.ts:240-276`,
  `governance-determinism.test.ts:133-136`, `prompts*.test.ts`,
  `inspector-v2.test.ts` — no spoken-conversation warmth path → **untouched**.
- `feed.test.ts:234/242/249` — verify its talks are direct `recordInteraction`
  / silent (no transcript) → no warmth event → **untouched**. If feed.test drives
  a spoken warm conversation, account for the extra event explicitly.
- `v2-full-loop.test.ts:240-242` — every `relationship_updated` event numeric &
  in range: the new warmth event satisfies this → **untouched**.

## Determinism & invariants — MUST hold (tests are the source of truth)
- **Zero `Math.random` / zero `Date`** in `sentiment.ts`, and in the new
  Relationships/Conversation/Cognition edits. Grep to prove it.
- **Full suite green** (`node_modules/vitest/vitest.mjs run`, currently **1259**).
- `node_modules/typescript/bin/tsc --noEmit` clean.
- **No map/persona/pathfinding change.** This slice touches only
  `src/agents/{sentiment.ts,Relationships.ts,Conversation.ts,Cognition.ts}`,
  `contracts/types.ts` (the `recordWarmth` method on `RelationshipStore`), and the
  two new tests.
- **Additive guarantee:** with no warm words (or `applyWarmth` unwired), behavior
  is byte-identical to today — a neutral chat is still exactly `+2`/side.
- `AFFINITY_DELTAS` constants (`TALK_TO: 2`, `GIVE_GIFT: 10`) are **unchanged**.

## Out of scope (explicit)
- **Negative sentiment / any affinity DECREASE from talking.** Warmth-only by
  user choice — no negative lexicon, hostile == neutral (`+2`).
- **LLM-derived sentiment + call metering** — deferred to C3 (this slice is
  deterministic/lexical, zero extra calls).
- **Per-speaker asymmetric warmth** (each side scored by what the OTHER said) —
  symmetric whole-transcript scoring this slice.
- **Affinity decay over time**, gossip-driven affinity, gift-sentiment.
- North Star doc update + commit + PR — orchestrator does these after the gate.
