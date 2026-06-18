# Multi-Hop Gossip with Origin Tracking + Belief Decay — Implementation Spec (Wave 4b)

> Relax the single-hop hearsay guard into bounded multi-hop relay (A→B→C "sharing news"), with provable termination. Additive + fire-and-forget + mock-deterministic. Suite 928 green → **928+ green + `tsc` clean**.

## Ground truth
- Gossip lives in `src/agents/Cognition.ts` inside `onTalk()`, AFTER reply generation + event diffusion. Hearsay guard `hearsayRe = /^[A-Za-z].* (?:mentioned:|told me|said:)/` BLOCKS relay today (single-hop). Candidate filter: `type==="observation" && importance>=5 && !hearsayRe.test(text)`. Salience: highest importance, ties → later-in-array. Dedup: `sharedGossip` Set keyed `speaker|listener|memId`. Listener memory: `${speaker} mentioned: ${gist}` (gist=truncateText(text,100)) at importance 4. Bus emit `kind:"gossip"`, text `${speaker} told ${listener} the news`.
- `write(agentName, type, text, importance, sourceIds?)` clamps importance to [1,10] integers (Math.round). `MemoryStore.append` spreads `...e` so new fields flow through if passed. `MemoryEntry` (contracts) has sourceIds?; no origin/hop yet.
- party-emergence uses EventBoard diffusion (independent path) — gossip must not perturb it. conversation.test.ts:428-449 asserts a `gossip` bus event fires on a first-hand share — must stay green.

## 1. Multi-hop relay design (termination is non-negotiable)
- **Origin id:** minted ONCE by the first-hand sharer = the source memory's `id` (e.g. "Alice-m3"), deterministic. Propagates UNCHANGED through every relay. (No UUIDs — determinism.)
- **Hop:** first-hand share → listener gets `hop=1`; relaying a `hop=n` memory → listener gets `hop=n+1`.
- Constants: `GOSSIP_MAX_HOPS=3`, `GOSSIP_DECAY=0.6`, `GOSSIP_BASE_IMPORTANCE=4`, `GOSSIP_MIN_RELAY_IMPORTANCE_FLOOR=1`.
- **Listener importance:** hop-1 pinned to 4 (keeps the frozen `importance===4` assertion). Relay: `clampRound(speakerGossipMem.importance * 0.6)` → hop2=2, hop3=1.
- **Relay gate:** relay a held gossip memory G only if `G.hop < GOSSIP_MAX_HOPS` AND `round(G.importance*0.6) >= FLOOR`. Hop cap is the load-bearing terminator; decay is the backstop.
- **Dedup on ORIGIN (not pair+memId):** replace `sharedGossip` with `knownOrigins: Map<agentName, Set<originId>>` + `knowsOrigin(name,origin)`/`markOrigin(name,origin)`. A relay to listener L happens only if L is NOT in knownOrigins[origin]; the write immediately marks L. With N agents, ≤ N−1 writes per origin (absorbing fixed point) → the storm guard that REPLACES the single-hop block.
- **Termination proof (3 independent monotone bounds):** (1) origin-dedup is absorbing — ≤N−1 writes/origin, fixed point reached; (2) hop strictly increases with ceiling MAX_HOPS=3; (3) decay drives importance below the relay floor. No feedback loop: a listener's relayed memory shares the SAME origin, so re-sharing to a knower is suppressed.

## 2. Contracts (additive, `contracts/types.ts`)
`MemoryEntry` += `origin?: string` (stable story-origin id) + `hop?: number` (relay distance, hop1 = direct). Both absent on non-gossip memories. Doc-comment both. Note in contracts/README.md (one line).

## 3. Cognition gossip-path changes
- Field: remove `sharedGossip`; add `private readonly knownOrigins = new Map<string, Set<string>>()` + `knowsOrigin`/`markOrigin` helpers.
- `write()` += optional final arg `meta?: { origin?: string; hop?: number }`, forwarded into `append({...})` via `...(meta?.origin?{origin:meta.origin}:{})` etc. Existing callers (≤5 args) unaffected.
- Pure helpers (exported for tests): `gossipCore(text)` strips `^<Name> mentioned( (heard from <Y>))?:\s*` to recover the bounded core story (prevents text growth across hops); `gossipTeller(text)` extracts the prior teller name.
- Rewrite the gossip block: build candidates = first-hand (`type==="observation" && importance>=5 && origin===undefined` — the `origin===undefined` STRUCTURAL check REPLACES the deleted hearsay regex) + relay (`origin!==undefined && hop<MAX_HOPS && round(importance*0.6)>=FLOOR`). For each compute origin/outHop/outImportance. FILTER OUT candidates whose origin the listener already knows. Salience-pick by SOURCE importance (array-order tie-break — keeps the frozen "treasure chest imp 9" test). On pick: markOrigin(speaker)+markOrigin(listener); gist=gossipCore(source)·truncate 100; text = outHop===1 ? `${speaker} mentioned: ${gist}` (BYTE-IDENTICAL legacy) : `${speaker} mentioned (heard from ${gossipTeller(sourceText) ?? speaker}): ${gist}`; `write(listener,"observation",text,outImportance,sourceIds,{origin,hop:outHop})`; emit `gossip` with additive `payload:{origin,hop:outHop}`. Keep the outer try/catch + fire-and-forget. NO onTalk signature change.

## 4. Test re-spec (`tests/agents/gossip.test.ts`)
- KEEP green-by-construction (relay design preserves them): importance===4 + "X mentioned:" prefix (hop-1 pinned/byte-identical); "second onTalk same pair → no dup" (now via origin-dedup: listener already knows origin); "per-pair different listener both get it" (each learns origin once); importance>=5 threshold (first-hand); no-memory/no-throw/bus-emit; salience picks imp-9.
- DELETE the hearsay-exclusion `describe` block (the `"X mentioned:"`-not-relayed + the `told me`/`said:` tests) — that single-hop guarantee is the intended relaxation, replaced by the bounded-multi-hop guarantees below.
- ADD `describe("multi-hop relay (bounded)")`: (1) A→B→C relay: C gets a memory incl. "heard from Alice", origin===Alice's obs id, hop===2; (2) origin-dedup: A→B then B→A yields nothing for A; A→B→C→A yields nothing; total gossip memories for origin ≤ N−1; (3) hop cap: A→B→C→D→E gives D hop-3 and E NOTHING; no memory hop>3; (4) decay: hop1 imp 4, hop2 imp 2, hop3 imp 1, non-increasing; (5) **TERMINATION/anti-storm (required):** 6 agents, seed 1 rumor, run 50 all-pairs talk rounds, assert gossip-write count STABILIZES (round 25 count === round 50 count) AND ≤ N−1 AND no hop>3; (6) determinism: same schedule twice → identical gossip memory texts/origins/hops/importances; (7) first-hand preference: agent with both a fresh first-hand imp-9 and a held hop-1 rumor shares the first-hand (hop1, no "heard from").
- CONFIRM green (no edit): conversation.test.ts (gossip-fires-alongside-reply), party-emergence, event-diffusion, mock-determinism, retrieval-determinism, cognition-integration.

## 5. Ownership (Wave 4b owns)
`src/agents/Cognition.ts` (gossip block + field swap + write() meta arg + helpers), `contracts/types.ts` (additive MemoryEntry origin/hop), `contracts/README.md` (one-line note), `tests/agents/gossip.test.ts` (re-spec). NO new file (small enough inline). Does NOT touch Conversation.ts/EventBoard.ts/Needs/Goals/Roles or world/render/scenes/server. FLAG: contracts/types.ts shared seam with governance (next) — this wave only adds MemoryEntry fields; governance adds ActionType/etc. separately. write() meta-arg is additive (governance's onVote doesn't change write()).

## 6. Risks
1. GOSSIP STORM/non-termination → 3 monotone bounds (origin-dedup absorbing ≤N−1, hop cap 3, decay); explicit termination test asserts stabilize + ≤N−1.
2. Mock non-determinism → origin = source memory id (deterministic), salience tie-break unchanged, provenance via deterministic regex; no RNG/time; determinism test.
3. Break party-emergence → gossip path independent of EventBoard; touches no events/knowerCount/tavern; extra relay writes don't affect its assertions; run it.
4. Memory spam → gossipCore strips wrapper each hop (bounded gist); ≤N−1 writes/origin; decayed importance adds little to reflection accumulator; origin-dedup prevents double-receive.
5. Break existing dedup tests → origin-dedup is STRICTLY STRONGER than pair+memId for the two frozen cases (both pass unchanged); only the hearsay-regex tests are intentionally removed.
