# FreeLLMAPI 429-Storm Resilience — Implementation Spec

> Wave 3c. Stop the self-inflicted 429 amplification so the live world stays on real LLM instead of mock-thrashing. Additive/surgical. Suite 834 green → **834+ green + `tsc` clean**. We do NOT manage FreeLLMAPI keys; this only makes us quiet+patient under upstream rate-limits.

## Root cause (verified, file:line)
Upstream 429s are real (FreeLLMAPI gateway `X-RateLimit-Limit: 120`/window) but we AMPLIFY them 3 ways:
1. **Unbatched embeddings (dominant):** `src/agents/memory/MemoryStore.ts:98` `this.embed([entry.text])` — one text per call, every memory write (recordOutcome/recordSpeech/recordNearbyActivity/onGift/onTalk → many writes/decision). `src/llm/embed.ts` batches at 32 but is only ever called with 1 → batching never engages. ~5-10 embed POSTs/sec.
2. **Completion retry re-fires on 429:** `server/llm/upstream.ts:226-227` marks 429 `bounceable:true` → bounded auto-retry loop (`:329-341`, AUTO_BACKUP_RETRIES=2, RETRY_BACKOFF_MS=[0,300]) → up to 3 POSTs per decision. 429 is a GLOBAL gateway window, so re-route can't escape it — pure waste.
3. **No breaker, no Retry-After:** grep for Retry-After/X-RateLimit across server/+src/ = nothing. We receive `X-RateLimit-Reset` and ignore it. `llm_offline` latch (AgentManager) is display-only. Embeddings forwarder has no retry (good) but no backoff/breaker.
Graceful mock fallback ALREADY exists + works (router.ts liveRouter never throws; embed.ts returns [] on fail; AgentRuntime WAIT/mock on error) — the storm degrades cleanly, just loudly.

## Fix A — 429 is NOT bounceable (kills 3× completion amplification)
`server/llm/upstream.ts:226-227`: change the 429 classification to `bounceable: false` so a rate-limit propagates immediately (1 POST, not 3). Keep network/5xx/model-not-found bounceable (those benefit from re-route). ~1-line semantic change.

## Fix B — Reset-honoring circuit breaker (biggest steady-state win)
`server/llm/upstream.ts` (+ minimal wiring): module-scoped breaker `{ openUntil: number }`. On any upstream 429, read `Retry-After` (seconds) or `X-RateLimit-Reset` (epoch seconds) from response headers; set `openUntil = nowMs + clamp(window, 0, 60_000)` (clamp absurd values to a 60s max; ignore unparseable). While `nowMs < openUntil`, BOTH `forwardCompletion` and `forwardEmbeddings` short-circuit at the top and return the 429 envelope WITHOUT hitting the network. First success after the window closes the breaker (reset openUntil=0). Breaker opens ONLY on 429 (401/5xx still propagate normally). Time source must be injectable/mockable for tests (e.g. a `now()` param/util, not a raw Date.now scattered) — keep it test-friendly.

## Fix C — Batch + debounce embeddings (kills the dominant volume source)
`src/agents/memory/MemoryStore.ts`: replace per-append `this.embed([entry.text])` with a micro-batch queue — push `{entry, text}` to a pending array; on first push schedule a ~250ms timer (or microtask coalescing) that drains up to `EMBED_BATCH_SIZE` (32, from embed.ts) into ONE `embedTexts(texts)` call, assigning vectors back by index. Preserve fire-and-forget + never-throw (rule 10). `append()` signature UNCHANGED (callers in Cognition untouched). Add a `stop()`/timer-clear for test teardown (avoid vitest open-handle leak). A burst of 6 writes in a tick → 1 POST instead of 6.

## Priority & effect
A (1 line) → B (breaker) → C (batching). A+B collapse the error rate to near-zero during a reset window; C stops re-triggering the window. Mock fallback already covers the open-breaker window.

## Tests (`tests/llm/server-v2.test.ts` harness: startUpstream records seen[], startApp on ephemeral port)
1. **429 not retried (A):** upstream always 429 → POST /api/agent/complete returns 429 AND `seen` has exactly 1 upstream POST (contrast existing 5xx case still bouncing).
2. **Breaker trips+recovers (B):** upstream 429 + `Retry-After: 1` (or X-RateLimit-Reset now+1). First POST → 1 upstream call, breaker opens; fire 5 more (complete+embeddings) → 0 new upstream calls, all return 429 fast; advance mock time >1s, flip stub to 200 → next POST hits upstream once + succeeds, breaker closed. Use injectable time / fake timers.
3. **Embeddings batched (C):** unit test on InMemoryMemoryStore with an embed spy; 6 synchronous `append()` in live mode + flush timers → spy called ONCE with a 6-element texts array, each entry gets its vector by index; >32 writes split into ceil(n/32) calls.
4. **Mock fallback clean (regression):** with breaker open, a runDecisionCycle still yields a valid WAIT/action turn + emits llm_offline once, no exceptions.

## Ownership (Wave 3c owns)
`server/llm/upstream.ts`, `server/app.ts` (minimal breaker wiring if needed), `src/agents/memory/MemoryStore.ts`, `src/llm/embed.ts` (only if a batch helper tweak is needed; it already batches at 32), `tests/llm/server-v2.test.ts` + a memory-store batching test. Does NOT touch `src/agents/{Needs,Goals,Cognition,Planner,Agent}`, `src/llm/{prompts,mock,router}` beyond read, `src/scenes/**`, `src/world/**`, `contracts/types.ts`, `src/obs/**` (other workstreams). NOTE: goal-gen owns src/agents/** EXCEPT MemoryStore.ts (the embedding path) which is THIS workstream's — append() signature stays identical so no collision with Cognition.

## Risks
1. Fix A: a transient single-provider 429 no longer dodged by re-route → that one cycle falls to mock (retries next cooldown). Gateway 429 (the real case) was never escapable anyway. Net win.
2. Fix B: trusting a wrong/huge Retry-After pauses legit throughput → clamp to ≤60s, ignore absurd, always close on first success; breaker opens only on 429 so 401/5xx propagate.
3. Fix C: ~250ms embed latency (embeddings already best-effort, 800ms query wait — well within tolerance); clear the timer on teardown.
4. None mask real errors — 401/5xx/malformed paths untouched; only 429 volume/cadence changes; llm_offline HUD badge still fires.
