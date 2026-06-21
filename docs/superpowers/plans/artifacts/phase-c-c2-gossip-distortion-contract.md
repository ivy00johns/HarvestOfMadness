# Contract — Phase C · Slice C2: Structured GossipBoard (subject/claim) + rumor distortion (Intensify)

**Branch:** `feat/phase-c-gossip-distortion`
**Goal:** Give relayed gossip a **structured `{subject, claim}`** representation and
make the rumor **intensify (exaggerate) as it relays** — Smallville's telephone
game, where the rumor grows wilder the further it travels. **User-chosen flavor:
INTENSIFY.** Subject stays stable (telephone keeps WHO); the rendered claim gains
an escalating amplifier at each relay hop.

## Why this shape (from the gossip-system survey)

The current gossip is already a bounded multi-hop relay (`Cognition.onTalk`,
Wave 4b, ~lines 901-1005): origin-dedup (`knownOrigins`), belief-decay
(`GOSSIP_DECAY=0.6`, importance 4→2→1), hop-cap (`GOSSIP_MAX_HOPS=3`). Crucially
it keeps the rumor **text byte-stable across hops** — `gossipCore()` strips
wrappers so the gist never grows; only the `"(heard from X)"` wrapper changes.

So "rumor distortion" **inherently** changes the hop-≥2 rendered text — that is
the feature. Risk is contained by two rules:

1. **Hop 1 stays byte-identical to today.** First-hand sharing is unaffected, so
   every importance-gate / dedup / salience / bus-event / hop-1-text assertion
   stays green untouched. Only relays (hop ≥ 2) distort.
2. **Carry the canonical claim in meta; intensify at RENDER, never in storage.**
   The gossip memory stores the *undistorted* canonical `claim` in its meta and
   propagates it unchanged (exactly like `origin`). The displayed `text` is
   rendered = wrapper + `intensifyClaim(claim, hop)`. When relaying, the next hop
   reads `meta.claim` (canonical) — NOT the prior distorted text — so distortion
   **cannot compound** and stays deterministic and bounded by the hop-cap (≤ 2
   distortion steps ever: hop 2 and hop 3).

This is the structure↔distortion coupling: the structured canonical claim is
exactly what makes Intensify deterministic.

## Files & changes

### 1. NEW pure module `src/agents/rumor.ts` (no Phaser, no LLM, no I/O)
```ts
/** Per-relay-hop intensifier ladder. Only hops 2..GOSSIP_MAX_HOPS ever apply
 *  (hop 1 = first-hand, faithful). Claim-agnostic escalating amplifiers — they
 *  read as the rumor growing without parsing the claim's content (no NLP, so it
 *  never produces nonsense on arbitrary observation text). */
export const RUMOR_INTENSIFIERS: Record<number, string> = {
  2: "…",   // hop-2 amplifier  (finalize wording in TDD so it reads well)
  3: "…",   // hop-3 amplifier  (stronger than hop 2 — escalation must be visible)
};

/** Apply the hop-indexed intensifier to a CANONICAL claim. Pure + deterministic:
 *  hop <= 1 → claim returned UNCHANGED (byte-identical first-hand); hop >= 2 →
 *  claim amplified by RUMOR_INTENSIFIERS[min(hop, max key)]. No RNG, no Date,
 *  claim-agnostic, bounded (idempotent per (claim,hop) — same input ⇒ same out). */
export function intensifyClaim(claim: string, hop: number): string { … }
```
- The amplifier must **escalate visibly** hop 2 → hop 3 and read as exaggeration
  ("rumor grows wilder"), e.g. a hop-2 "word is, " / hop-3 "the whole town swears "
  framing, or an escalating superlative clause — **finalize the exact wording in
  TDD so it reads naturally on the real fixture claims** (the test fixtures use
  e.g. `"I found a treasure chest buried near the well"`). Keep it claim-agnostic.
- Exact intensifier strings are NOT pinned word-for-word by the unit test — only
  the OBSERVABLE properties (hop1 unchanged, hop2 ≠ hop1, hop3 ≠ hop2, escalation,
  determinism). So wording can be tuned without churning the unit test.

### 2. `contracts/types.ts` — structured rumor fields (additive, optional)
Add to `MemoryEntry` (next to the existing gossip-only `origin?` / `hop?`):
```ts
  /** Wave 4c (C2): the rumor's SUBJECT — the first-hand author the rumor traces
   *  to, captured at hop 1 and propagated UNCHANGED (gossip-only, like origin). */
  subject?: string;
  /** Wave 4c (C2): the CANONICAL (undistorted) claim gist, captured at hop 1 and
   *  propagated UNCHANGED. The rendered `text` applies intensifyClaim(claim,hop);
   *  relays read THIS, never the distorted text, so distortion never compounds. */
  claim?: string;
```
These are gossip-only optional fields — absent on every non-gossip memory, so the
shape is stable and all existing memory assertions are untouched.

### 3. `src/agents/Cognition.ts` — capture structure + render the intensifier
In the Wave 4b relay block (`onTalk`, ~lines 901-1005):
- **Candidate build:** for a FIRST-HAND candidate (origin === undefined), set
  `subject = speaker.name` (the first-hand author) and `claim = gossipCore(m.text)`
  (the canonical gist, as today). For a RELAY candidate (a held gossip memory),
  read `subject = m.subject` and `claim = m.claim` **from meta** (NOT by parsing
  `m.text`) — falling back to `gossipCore(m.text)` only if `m.claim` is absent
  (defensive; pre-existing rumor memories without the new fields).
- **Render:** the displayed text becomes the existing wrapper around
  `intensifyClaim(claim, outHop)`:
  - hop 1: `${speaker} mentioned: ${intensifyClaim(claim, 1)}` — `intensifyClaim`
    returns the claim unchanged at hop 1 ⇒ **byte-identical to today**.
  - hop ≥ 2: `${speaker} mentioned (heard from ${teller}): ${intensifyClaim(claim, outHop)}`
    ⇒ the intensified claim.
- **Write meta:** extend the gossip `write(...)` meta from `{ origin, hop }` to
  `{ origin, hop, subject, claim }` (claim = the **canonical** gist, undistorted).
- **Bus event:** extend the `"gossip"` payload from `{ origin, hop }` to
  `{ origin, hop, subject, claim }` (canonical claim) so the feed/inspector can
  show structured rumors. (Verify gossip.test.ts:299 uses `toMatchObject`/partial,
  not exact `toEqual`, before relying on additive payload growth.)

Keep ALL existing relay machinery unchanged: origin-dedup, salience by source
importance, `GOSSIP_DECAY`/`GOSSIP_BASE_IMPORTANCE`/`GOSSIP_MAX_HOPS`/floor,
`gossipCore`/`gossipTeller`, the `markOrigin` calls, the importance<5 first-hand
gate. Distortion touches **only** the rendered claim text + the new meta fields.

### 4. NEW test `tests/agents/rumor.test.ts` (pure-module teeth)
- hop 1 → claim returned unchanged (byte-identical).
- hop 2 ≠ claim; hop 3 ≠ hop 2; the hop-3 form is "more intensified" than hop 2
  (escalation visible — e.g. length or a pinned escalation property).
- claim-agnostic: a totally different claim string also intensifies (no fixture
  coupling, no nonsense, never throws on empty/odd input → empty in, empty/handled out).
- determinism: same `(claim, hop)` ⇒ same output across calls.
- source-grep: zero `Math.random` / `Date` in `rumor.ts`.

### 5. NEW test `tests/agents/gossip-distortion.test.ts` (the payoff)
Through the real `Cognition.onTalk` relay (same harness as `gossip.test.ts`):
- **A→B→C→D:** B's hop-1 memory is **byte-identical to today** (faithful); C's
  hop-2 and D's hop-3 memories carry the **escalating intensified** claim, and
  the escalation hop2→hop3 is visible. Pin the structured fields: every relay
  memory carries `subject === <first-hand author>` (unchanged across hops) and
  `claim === <canonical gist>` (unchanged across hops) while the rendered `text`
  differs by hop.
- **Distortion does NOT compound:** D's stored `meta.claim` equals the canonical
  gist (not C's distorted text) — proves the read-from-meta rule.
- **Determinism:** two identical relay schedules → identical texts/subjects/claims/
  hops/importances.
- **Structured bus payload:** the `"gossip"` event carries `{ subject, claim }`.

### 6. Updated frozen assertions in `tests/agents/gossip.test.ts` (EXPECTED churn)
Distortion changes the hop-≥2 rendered text. Update **only** the relay-text
assertions, each to the new intensified text, hand-verified and mutation-teethed:
- **~line 395** (`A→B→C relay`): Carol's hop-2 text changes from
  `"Bob mentioned (heard from Alice): I found a treasure chest buried near the well"`
  to the **intensified** hop-2 form. The `origin === Alice's id`, `hop === 2`,
  `importance` (decay) assertions **stay unchanged**.
- **~line 473** (`hop cap A→B→C→D→E`): if it asserts D's exact hop-3 TEXT, update
  to the intensified hop-3 form; the hop-count + "E gets nothing" assertions stay.
- **~line 580** (`determinism`): compares run1 vs run2 (not a literal) ⇒ stays
  green; if it pins literal expected text, update it.
- Everything else in gossip.test.ts (gate boundaries 191/227/244, dedup 137/159,
  salience 343, bus-event 299/319, hop-1 text 87/111, decay 508, first-hand-pref
  634) is **hop-1 / gate / count** and stays green untouched.
For EACH updated assertion: hand-verify the new text by tracing `intensifyClaim`,
then prove teeth (inject a wrong expected value → RED → restore).

## Determinism & invariants — MUST hold (tests are the source of truth)
- **Zero `Math.random` / zero `Date`** in `rumor.ts` and the Cognition edits.
- **Full suite green** (`node_modules/vitest/vitest.mjs run`, currently **1279**).
- `node_modules/typescript/bin/tsc --noEmit` clean.
- **Hop-1 byte-identical:** first-hand gossip text/importance/origin/dedup/bus all
  unchanged — distortion is relay-only (hop ≥ 2).
- **Distortion cannot compound:** relays read `meta.claim` (canonical), never the
  prior distorted text. Bounded ≤ 2 distortion steps by `GOSSIP_MAX_HOPS=3`.
- All gossip CONSTANTS unchanged (`GOSSIP_MAX_HOPS=3`, `GOSSIP_DECAY=0.6`,
  `GOSSIP_BASE_IMPORTANCE=4`, floor=1, first-hand gate importance≥5).
- No map/persona/pathfinding change. Touches only `src/agents/rumor.ts` (new),
  `src/agents/Cognition.ts` (relay render + meta), `contracts/types.ts` (2 optional
  fields), and the new/updated tests.

## Out of scope (explicit — record as deferred)
- **Dedicated GossipBoard CLASS / inspector PANEL.** This slice delivers the
  structured `{subject, claim}` at the DATA layer (memory meta + bus payload) —
  the foundation. A standalone `GossipBoard` store + a HUD "rumors in circulation"
  panel is a natural follow-on (UI slice) and is DEFERRED, not delivered here.
- **Erode / Garble distortion flavors** (Intensify chosen).
- **Live-LLM rumor rewriting** (deterministic intensifier only; live-LLM deferred to C3).
- **Subject extraction beyond the first-hand author** (no NLP entity parsing —
  subject = the captured first-hand author name, propagated).
- **Distorting the SUBJECT** (telephone keeps WHO; only the claim intensifies).
- North Star doc update + commit + PR — orchestrator does these after the gate.
